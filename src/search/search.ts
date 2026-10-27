import { type FSWatcher, mkdirSync, statSync, watch } from "node:fs";
import { basename, join } from "node:path";
import type { Artifacts } from "../artifacts/artifacts.ts";
import type { Threads } from "../threads/threads.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";
import { documentPrompt, type Embedder, queryPrompt } from "./embedder.ts";
import {
  type ExtractedSegment,
  type Extraction,
  extract,
  htmlText,
  isIgnored,
} from "./extract.ts";
import {
  chunk,
  type SearchKind,
  type SearchResult,
  type Segment,
  WorkspaceIndex,
} from "./workspace-index.ts";

/** Folders of a workspace that are indexed, and what their files are. Channel files are found per channel. */
const FOLDERS: readonly { folder: string; kind: SearchKind }[] = [
  { folder: "notes", kind: "note" },
  { folder: "files", kind: "file" },
  { folder: "raw", kind: "capture" },
];
const SCAN_EVERY_MS = 60_000;

export interface SearchResponse {
  readonly results: readonly SearchResult[];
  readonly semantic: boolean;
}

/**
 * Keeps each workspace's index in step with its threads and folders, and embeds in the background.
 * Every index belongs to one workspace and reads only that workspace's folder; searches never cross workspaces.
 */
/** What the indexer reads from the directory in `golem.sqlite`: every workspace, and the channels and threads in one. */
export type WorkspaceDirectory = Pick<
  Workspaces,
  "ids" | "channelsIn" | "threadsIn"
>;
/** The indexer reads thread messages; it never writes to a thread. */
export type ThreadReader = Pick<Threads, "messages" | "version">;
/** The indexer reads the live artifacts and their HTML. */
export type ArtifactReader = Pick<Artifacts, "inWorkspace" | "html">;

export class Indexer {
  private readonly indexes = new Map<string, WorkspaceIndex>();
  private readonly scans = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly watchers: FSWatcher[] = [];
  private closed = false;

  constructor(
    private readonly dataDirectory: string,
    private readonly directory: WorkspaceDirectory,
    private readonly threads: ThreadReader,
    private readonly artifacts: ArtifactReader,
    private readonly embedder: Embedder | null
  ) {}

  /** Scans every workspace now and then every minute, which also embeds what waited for the model. */
  start(): void {
    const watched = new Set<string>();
    const scanAll = () => {
      for (const id of this.directory.ids()) {
        if (!watched.has(id)) {
          watched.add(id);
          this.watchFolders(id);
        }
        this.scan(id).catch((error: unknown) =>
          console.error(`Indexing ${id} failed`, error)
        );
      }
    };
    scanAll();
    this.timer = setInterval(scanAll, SCAN_EVERY_MS);
  }

  /** Schedules a scan soon, after something changed in the workspace. */
  touch(workspaceId: string): void {
    if (this.closed) {
      return;
    }
    clearTimeout(this.pending.get(workspaceId));
    this.pending.set(
      workspaceId,
      setTimeout(() => {
        this.pending.delete(workspaceId);
        this.scan(workspaceId).catch((error: unknown) =>
          console.error(`Indexing ${workspaceId} failed`, error)
        );
      }, 1000)
    );
  }

  /** One scan at a time per workspace; a scan asked for during another waits for it. */
  scan(workspaceId: string): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    const running = this.scans.get(workspaceId);
    const next = (running ?? Promise.resolve()).then(() =>
      this.scanNow(workspaceId)
    );
    this.scans.set(
      workspaceId,
      next.catch(() => undefined)
    );
    return next;
  }

  /**
   * Searches one workspace, for `personId`: their own thread with Golem is in the results, and no other person's.
   * The caller has checked that the person is a member. Results of a deleted channel or artifact stay out at once,
   * before the next scan takes them from the index.
   */
  async search(
    workspaceId: string,
    query: string,
    limit: number,
    personId: string | null
  ): Promise<SearchResponse> {
    const index = this.index(workspaceId);
    let vector: Float32Array | null = null;
    if (this.embedder?.ready() && query.trim()) {
      vector =
        (
          await this.embedder.embed([queryPrompt(query)]).catch(() => [null])
        )[0] ?? null;
    }
    const channels = new Set(
      this.directory.channelsIn(workspaceId).map((channel) => channel.id)
    );
    const othersOwn = new Set(
      this.directory
        .threadsIn(workspaceId)
        .filter(
          (thread) => thread.ownerId !== null && thread.ownerId !== personId
        )
        .map((thread) => `thread:${thread.id}`)
    );
    const artifacts = new Set(
      this.artifacts
        .inWorkspace(workspaceId)
        .map((artifact) => `artifact:${artifact.id}`)
    );
    return {
      results: index
        .search(query, vector, limit)
        .filter(
          (result) =>
            (result.channelId === null || channels.has(result.channelId)) &&
            (result.kind !== "artifact" || artifacts.has(result.uri)) &&
            !othersOwn.has(result.uri)
        ),
      semantic: vector !== null,
    };
  }

  status(workspaceId: string) {
    return {
      ...this.index(workspaceId).counts(),
      model: this.embedder?.ready() ?? false,
    };
  }

  /** Stops scanning, waits for the scans that run, then closes the index files. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const watcher of this.watchers) {
      watcher.close();
    }
    for (const timeout of this.pending.values()) {
      clearTimeout(timeout);
    }
    await Promise.all(this.scans.values());
    for (const index of this.indexes.values()) {
      index.close();
    }
    this.indexes.clear();
  }

  /** Creates the folders people drop files into, and scans a second after anything in them changes. */
  private watchFolders(workspaceId: string): void {
    for (const folder of [
      ...FOLDERS.map((indexed) => indexed.folder),
      "channels",
    ]) {
      const directory = join(this.workspaceDirectory(workspaceId), folder);
      mkdirSync(directory, { recursive: true });
      try {
        this.watchers.push(
          watch(directory, { recursive: true }, () => this.touch(workspaceId))
        );
      } catch {
        // Without file watching the scan every minute still finds new files.
      }
    }
  }

  private async scanNow(workspaceId: string): Promise<void> {
    const index = this.index(workspaceId);
    const root = this.workspaceDirectory(workspaceId);
    const seen = new Set<string>();
    for (const thread of this.directory.threadsIn(workspaceId)) {
      const uri = `thread:${thread.id}`;
      seen.add(uri);
      await index.sync(
        {
          uri,
          kind: "thread",
          title: thread.title,
          threadId: thread.id,
          channelId: thread.channelId,
          // A new name also indexes the thread again.
          version: `${await this.threads.version(thread)}:${thread.title}`,
          updatedAt: thread.updatedAt,
        },
        async () => {
          const { messages } = await this.threads.messages(thread);
          const segments = messages
            .filter((message) => !(message.streaming || message.failed))
            .flatMap((message) =>
              chunk(`${message.author}: ${message.text}`).map((text, part) => ({
                key: `${message.id}:${part}`,
                text,
              }))
            );
          return { segments };
        }
      );
    }
    for (const artifact of this.artifacts.inWorkspace(workspaceId)) {
      const uri = `artifact:${artifact.id}`;
      seen.add(uri);
      await index.sync(
        {
          uri,
          kind: "artifact",
          title: artifact.title,
          threadId: artifact.threadId,
          channelId: artifact.channelId ?? undefined,
          version: String(artifact.updatedAt),
          updatedAt: artifact.updatedAt,
        },
        async () => ({
          segments: chunk(htmlText(this.artifacts.html(artifact.id))).map(
            (text, part) => ({ key: String(part), text })
          ),
        })
      );
    }
    for (const channel of this.directory.channelsIn(workspaceId)) {
      await this.syncFolder(
        index,
        seen,
        root,
        join("channels", channel.id, "files"),
        "file",
        channel.id
      );
    }
    for (const { folder, kind } of FOLDERS) {
      await this.syncFolder(index, seen, root, folder, kind);
    }
    index.prune(seen);
    await this.embedWaiting(index);
  }

  private async syncFolder(
    index: WorkspaceIndex,
    seen: Set<string>,
    root: string,
    folder: string,
    kind: SearchKind,
    channelId?: string
  ): Promise<void> {
    const directory = join(root, folder);
    let paths: string[];
    try {
      paths = await Array.fromAsync(
        new Bun.Glob("**/*").scan({
          cwd: directory,
          onlyFiles: true,
          dot: false,
        })
      );
    } catch {
      return; // the folder does not exist yet
    }
    for (const relative of paths) {
      if (relative.split("/").some(isIgnored)) {
        continue;
      }
      const path = join(directory, relative);
      const stats = statSync(path, { throwIfNoEntry: false });
      if (!stats) {
        continue;
      }
      const uri = `${folder}/${relative}`;
      const version = `${stats.mtimeMs}:${stats.size}`;
      seen.add(uri);
      // Channel files start with their UUIDv7, which is no part of their name.
      const title = basename(relative)
        .replace(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}-/,
          ""
        )
        .replace(/\.[^.]+$/, "");
      await index.sync(
        {
          uri,
          kind,
          title,
          channelId,
          version,
          updatedAt: Math.round(stats.mtimeMs),
        },
        async () => {
          const extraction = await extract(path).catch((error: unknown) => {
            console.error(
              `Could not read ${uri}:`,
              error instanceof Error ? error.message : error
            );
            return { segments: [] } as Extraction;
          });
          return {
            title: extraction.title,
            segments: [
              // The path is always searchable by keywords, also for files Golem cannot read.
              { key: "name", text: relative, modality: "none" as const },
              ...(await this.withMediaVectors(extraction.segments, version)),
            ],
          };
        }
      );
    }
  }

  /** Embeds pictures and audio while their bytes are at hand; text waits for the background pass. */
  private async withMediaVectors(
    segments: readonly ExtractedSegment[],
    version: string
  ): Promise<Segment[]> {
    const isMedia = (
      segment: ExtractedSegment
    ): segment is Extract<ExtractedSegment, { media: Uint8Array }> =>
      segment.modality === "image" || segment.modality === "audio";
    const media = segments.filter(isMedia);
    const vectors =
      media.length && this.embedder?.ready()
        ? await this.embedder
            .embed(
              media.map((segment) =>
                segment.modality === "image"
                  ? { image: segment.media }
                  : { audio: segment.media }
              )
            )
            .catch((error: unknown) => {
              console.error(
                "Embedding pictures or audio failed:",
                error instanceof Error ? error.message : error
              );
              return [];
            })
        : [];
    return segments.map((segment) => {
      if (!isMedia(segment)) {
        return segment;
      }
      const { media: _, ...rest } = segment;
      return {
        ...rest,
        hash: `${version}:${segment.key}`,
        vector: vectors[media.indexOf(segment)],
      };
    });
  }

  private async embedWaiting(index: WorkspaceIndex): Promise<void> {
    const { embedder } = this;
    if (!embedder?.ready()) {
      return;
    }
    for (
      let batch = index.waiting(64);
      batch.length > 0;
      batch = index.waiting(64)
    ) {
      const vectors = await embedder.embed(
        batch.map((segment) => documentPrompt(segment.text, segment.title))
      );
      index.storeVectors(
        batch.map((segment, position) => ({
          id: segment.id,
          vector: vectors[position]!,
        }))
      );
    }
  }

  private index(workspaceId: string): WorkspaceIndex {
    let index = this.indexes.get(workspaceId);
    if (!index) {
      const directory = this.workspaceDirectory(workspaceId);
      mkdirSync(directory, { recursive: true });
      index = new WorkspaceIndex(
        join(directory, "index.sqlite"),
        this.embedder?.fingerprint ?? "keywords"
      );
      this.indexes.set(workspaceId, index);
    }
    return index;
  }

  private workspaceDirectory(workspaceId: string): string {
    // Ids come from the database, but a path must never leave the workspaces folder.
    if (!/^[\w-]+$/.test(workspaceId)) {
      throw new Error(`Invalid workspace id: ${workspaceId}`);
    }
    return join(this.dataDirectory, "workspaces", workspaceId);
  }
}

import type { Database } from "bun:sqlite";
import { type FSWatcher, mkdirSync, statSync, watch } from "node:fs";
import { basename, join } from "node:path";
import type { Artifacts } from "../artifacts/artifacts.ts";
import type { Chats } from "../chats/chats.ts";
import { HttpError } from "../platform/errors.ts";
import { htmlText } from "../platform/html.ts";
import type { Realm, Workspaces } from "../workspaces/workspaces.ts";
import { documentPrompt, type Embedder, queryPrompt } from "./embedder.ts";
import {
  type ExtractedSegment,
  type Extraction,
  extract,
  isIgnored,
} from "./extract.ts";
import {
  chunk,
  type SearchKind,
  type SearchResult,
  type Segment,
  WorkspaceIndex,
} from "./workspace-index.ts";

/** Folders of a workspace that are indexed, and what their files are. Topic files are found per topic. */
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

/** A query that a person searched, and when they last searched it. */
export interface RecentSearch {
  readonly query: string;
  readonly searchedAt: number;
}

/** The newest searches the search page shows. */
const RECENT_SEARCHES = 10;
const MAX_QUERY = 200;

/**
 * What each person searched in a workspace, newest first; the search page shows it before a query. The caller has
 * checked that the person is a member.
 */
export class RecentSearches {
  constructor(private readonly database: Database) {}

  list(workspaceId: string, userId: string): RecentSearch[] {
    return this.database
      .query(
        "SELECT query, searched_at AS searchedAt FROM recent_search WHERE workspace_id = ? AND user_id = ? ORDER BY searched_at DESC LIMIT ?"
      )
      .all(workspaceId, userId, RECENT_SEARCHES) as RecentSearch[];
  }

  /** Saves a search; the same query again, in any case, only moves to the top. */
  add(workspaceId: string, userId: string, query: unknown): RecentSearch[] {
    const text = typeof query === "string" ? query.trim() : "";
    if (!text || text.length > MAX_QUERY) {
      throw new HttpError(400, `Query must be 1 to ${MAX_QUERY} characters`);
    }
    this.database
      .query(
        "INSERT INTO recent_search (workspace_id, user_id, query, searched_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET query = excluded.query, searched_at = excluded.searched_at"
      )
      .run(workspaceId, userId, text, Date.now());
    return this.list(workspaceId, userId);
  }
}

/**
 * Keeps each workspace's index in step with its chats and folders, and embeds in the background.
 * Every index belongs to one workspace and reads only that workspace's folder; searches never cross workspaces.
 */
/** What the indexer reads from the directory in `golem.sqlite`: every workspace, and the topics and chats in one. */
export type WorkspaceDirectory = Pick<
  Workspaces,
  "ids" | "allTopicsIn" | "allChatsIn" | "topicsIn" | "chatsIn"
>;
/** The indexer reads chat messages; it never writes to a chat. */
export type ChatReader = Pick<Chats, "messages" | "version">;
/** The indexer reads the live artifacts and their HTML. */
export type ArtifactReader = Pick<
  Artifacts,
  "allInWorkspace" | "inWorkspace" | "html"
>;

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
    private readonly chats: ChatReader,
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
   * Searches one workspace for what `realm` sees: the topics every member sees, and the person's own chat with
   * Golem and private topics; no other person's. The caller has checked that the person is a member. Results of a
   * deleted topic or artifact stay out at once, before the next scan takes them from the index.
   */
  async search(
    workspaceId: string,
    query: string,
    limit: number,
    realm: Realm,
    kind?: SearchKind
  ): Promise<SearchResponse> {
    const index = this.index(workspaceId);
    let vector: Float32Array | null = null;
    if (this.embedder?.ready() && query.trim()) {
      vector =
        (
          await this.embedder.embed([queryPrompt(query)]).catch(() => [null])
        )[0] ?? null;
    }
    const topics = new Set(
      this.directory.topicsIn(workspaceId, realm).map((topic) => topic.id)
    );
    // Chats as the person sees them now: a chat that moved leaves search at once, before the next scan.
    const chats = new Set(
      this.directory
        .chatsIn(workspaceId, realm)
        .map((chat) => `chat:${chat.id}`)
    );
    const artifacts = new Set(
      this.artifacts
        .inWorkspace(workspaceId, realm)
        .map((artifact) => `artifact:${artifact.id}`)
    );
    return {
      results: index.search(
        query,
        vector,
        limit,
        (source) =>
          (kind === undefined || source.kind === kind) &&
          (source.topicId === null || topics.has(source.topicId)) &&
          (source.kind !== "artifact" || artifacts.has(source.uri)) &&
          (source.kind !== "chat" || chats.has(source.uri))
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
      "topics",
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
    for (const chat of this.directory.allChatsIn(workspaceId)) {
      const uri = `chat:${chat.id}`;
      seen.add(uri);
      await index.sync(
        {
          uri,
          kind: "chat",
          title: chat.title,
          chatId: chat.id,
          topicId: chat.topicId,
          // A new name or topic also indexes the chat again; unchanged messages keep their vectors.
          version: `${await this.chats.version(chat)}:${chat.title}:${chat.topicId}:tools`,
          updatedAt: chat.updatedAt,
        },
        async () => {
          const { messages } = await this.chats.messages(chat);
          const segments = messages
            .filter((message) => !(message.streaming || message.failed))
            .flatMap((message) => [
              ...chunk(`${message.author}: ${cardWords(message.text)}`).map(
                (text, part) => ({ key: `${message.id}:${part}`, text })
              ),
              // A tool call's arguments find a chat by whom it wrote to, and what it saved or looked up.
              ...(message.work?.steps ?? []).flatMap((step, stepIndex) =>
                step.kind === "tool" && step.input
                  ? chunk(`${step.tool}: ${step.input}`).map((text, part) => ({
                      key: `${message.id}:tool:${stepIndex}:${part}`,
                      text,
                    }))
                  : []
              ),
            ]);
          return { segments };
        }
      );
    }
    for (const artifact of this.artifacts.allInWorkspace(workspaceId)) {
      const uri = `artifact:${artifact.id}`;
      seen.add(uri);
      await index.sync(
        {
          uri,
          kind: "artifact",
          title: artifact.title,
          chatId: artifact.chatId,
          topicId: artifact.topicId ?? undefined,
          version: `${artifact.updatedAt}:${artifact.topicId}`,
          updatedAt: artifact.updatedAt,
        },
        async () => ({
          segments: chunk(htmlText(this.artifacts.html(artifact.id))).map(
            (text, part) => ({ key: String(part), text })
          ),
        })
      );
    }
    for (const topic of this.directory.allTopicsIn(workspaceId)) {
      await this.syncFolder(
        index,
        seen,
        root,
        join("topics", topic.id, "files"),
        "file",
        topic.id
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
    topicId?: string
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
      // Topic files start with their UUIDv7, which is no part of their name.
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
          topicId,
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

/**
 * A message with its fenced `card` blocks as the words people read on the cards, a list item for each card, so search
 * matches and shows them as text. A block that is not valid stays, as the apps show it as code.
 *
 * @example cardWords('```card\n{"title": "Car", "value": "78 %", "detail": "412 km"}\n```') // "- Car: 78 %, 412 km"
 */
export function cardWords(text: string): string {
  return text.replace(
    /^```card[^\n]*\n([\s\S]*?)^```[^\S\n]*$/gm,
    (block, json: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        return block;
      }
      const cards = (Array.isArray(parsed) ? parsed : [parsed]) as {
        title?: unknown;
        value?: unknown;
        detail?: unknown;
      }[];
      if (!cards.every((card) => typeof card?.value === "string")) {
        return block;
      }
      return cards
        .map((card) => {
          const value = [card.value, card.detail]
            .filter((part) => typeof part === "string" && part)
            .join(", ");
          return typeof card.title === "string" && card.title
            ? `- ${card.title}: ${value}`
            : `- ${value}`;
        })
        .join("\n");
    }
  );
}

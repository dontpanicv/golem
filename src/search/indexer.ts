import type { Database } from "bun:sqlite";
import { type FSWatcher, mkdirSync, statSync, watch } from "node:fs";
import { basename, join } from "node:path";
import type { Threads } from "../threads.ts";
import { documentPrompt, type Embedder, queryPrompt } from "./embedder.ts";
import { type Extraction, type ExtractedSegment, extract, isIgnored } from "./extract.ts";
import { chunk, type SearchKind, type SearchResult, type Segment, WorkspaceIndex } from "./workspace-index.ts";

/** Folders of a workspace that are indexed, and what their files are. Thread files are found per thread. */
const FOLDERS: readonly { folder: string; kind: SearchKind }[] = [
	{ folder: "notes", kind: "note" },
	{ folder: "files", kind: "file" },
	{ folder: "raw", kind: "capture" },
];
const SCAN_EVERY_MS = 60_000;

export type SearchResponse = { readonly results: readonly SearchResult[]; readonly semantic: boolean };

/**
 * Keeps each workspace's index in step with its threads and folders, and embeds in the background.
 * Every index belongs to one workspace and reads only that workspace's folder; searches never cross workspaces.
 */
export class Indexer {
	private readonly indexes = new Map<string, WorkspaceIndex>();
	private readonly scans = new Map<string, Promise<void>>();
	private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly watchers: FSWatcher[] = [];

	constructor(
		private readonly dataDirectory: string,
		private readonly database: Database,
		private readonly threads: Threads,
		private readonly embedder: Embedder | null,
	) {}

	/** Scans every workspace now and then every minute, which also embeds what waited for the model. */
	start(): void {
		const watched = new Set<string>();
		const scanAll = () => {
			const workspaces = this.database.query("SELECT id FROM organization").all() as { id: string }[];
			for (const { id } of workspaces) {
				if (!watched.has(id)) {
					watched.add(id);
					this.watchFolders(id);
				}
				void this.scan(id).catch((error: unknown) => console.error(`Indexing ${id} failed`, error));
			}
		};
		scanAll();
		this.timer = setInterval(scanAll, SCAN_EVERY_MS);
	}

	/** Schedules a scan soon, after something changed in the workspace. */
	touch(workspaceId: string): void {
		clearTimeout(this.pending.get(workspaceId));
		this.pending.set(
			workspaceId,
			setTimeout(() => {
				this.pending.delete(workspaceId);
				void this.scan(workspaceId).catch((error: unknown) => console.error(`Indexing ${workspaceId} failed`, error));
			}, 1000),
		);
	}

	/** One scan at a time per workspace; a scan asked for during another waits for it. */
	scan(workspaceId: string): Promise<void> {
		const running = this.scans.get(workspaceId);
		const next = (running ?? Promise.resolve()).then(() => this.scanNow(workspaceId));
		this.scans.set(workspaceId, next.catch(() => undefined));
		return next;
	}

	/** Searches one workspace. The caller has checked that the person is a member. */
	async search(workspaceId: string, query: string, limit = 20): Promise<SearchResponse> {
		const index = this.index(workspaceId);
		let vector: Float32Array | null = null;
		if (this.embedder?.ready() && query.trim()) {
			vector = (await this.embedder.embed([queryPrompt(query)]).catch(() => [null]))[0] ?? null;
		}
		return { results: index.search(query, vector, limit), semantic: vector !== null };
	}

	status(workspaceId: string) {
		return { ...this.index(workspaceId).counts(), model: this.embedder?.ready() ?? false };
	}

	close(): void {
		clearInterval(this.timer);
		for (const watcher of this.watchers) watcher.close();
		for (const timeout of this.pending.values()) clearTimeout(timeout);
		for (const index of this.indexes.values()) index.close();
		this.indexes.clear();
	}

	/** Creates the folders people drop files into, and scans a second after anything in them changes. */
	private watchFolders(workspaceId: string): void {
		for (const { folder } of FOLDERS) {
			const directory = join(this.workspaceDirectory(workspaceId), folder);
			mkdirSync(directory, { recursive: true });
			try {
				this.watchers.push(watch(directory, { recursive: true }, () => this.touch(workspaceId)));
			} catch {
				// Without file watching the scan every minute still finds new files.
			}
		}
	}

	private async scanNow(workspaceId: string): Promise<void> {
		const index = this.index(workspaceId);
		const root = this.workspaceDirectory(workspaceId);
		const seen = new Set<string>();
		const threads = this.database
			.query("SELECT id, channel_id AS channelId, title, updated_at AS updatedAt FROM thread WHERE workspace_id = ?")
			.all(workspaceId) as { id: string; channelId: string; title: string; updatedAt: number }[];
		for (const thread of threads) {
			const directory = join(root, "threads", thread.id);
			const version = versionOf(join(directory, "session.sqlite"), join(directory, "session.sqlite-wal"));
			if (version === null) continue;
			const uri = `thread:${thread.id}`;
			seen.add(uri);
			await index.sync({ uri, kind: "thread", title: thread.title, threadId: thread.id, channelId: thread.channelId, version, updatedAt: thread.updatedAt }, async () => {
				const { messages } = await this.threads.messages({ id: thread.id, workspaceId });
				const segments = messages
					.filter((message) => !message.streaming && !message.failed)
					.flatMap((message) => chunk(`${message.author}: ${message.text}`).map((text, part) => ({ key: `${message.id}:${part}`, text })));
				return { segments };
			});
			await this.syncFolder(index, seen, root, join("threads", thread.id, "files"), "file", thread);
		}
		for (const { folder, kind } of FOLDERS) await this.syncFolder(index, seen, root, folder, kind);
		index.prune(seen);
		await this.embedWaiting(index);
	}

	private async syncFolder(
		index: WorkspaceIndex,
		seen: Set<string>,
		root: string,
		folder: string,
		kind: SearchKind,
		thread?: { id: string; channelId: string },
	): Promise<void> {
		const directory = join(root, folder);
		let paths: string[];
		try {
			paths = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true, dot: false }));
		} catch {
			return; // the folder does not exist yet
		}
		for (const relative of paths) {
			if (relative.split("/").some(isIgnored)) continue;
			const path = join(directory, relative);
			const stats = statSync(path, { throwIfNoEntry: false });
			if (!stats) continue;
			const uri = `${folder}/${relative}`;
			const version = `${stats.mtimeMs}:${stats.size}`;
			seen.add(uri);
			const title = basename(relative).replace(/\.[^.]+$/, "");
			await index.sync(
				{ uri, kind, title, threadId: thread?.id, channelId: thread?.channelId, version, updatedAt: Math.round(stats.mtimeMs) },
				async () => {
					const extraction = await extract(path).catch((error: unknown) => {
						console.error(`Could not read ${uri}:`, error instanceof Error ? error.message : error);
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
				},
			);
		}
	}

	/** Embeds pictures and audio while their bytes are at hand; text waits for the background pass. */
	private async withMediaVectors(segments: readonly ExtractedSegment[], version: string): Promise<Segment[]> {
		const isMedia = (segment: ExtractedSegment): segment is Extract<ExtractedSegment, { media: Uint8Array }> =>
			segment.modality === "image" || segment.modality === "audio";
		const media = segments.filter(isMedia);
		const vectors =
			media.length && this.embedder?.ready()
				? await this.embedder
						.embed(media.map((segment) => (segment.modality === "image" ? { image: segment.media } : { audio: segment.media })))
						.catch((error: unknown) => {
							console.error("Embedding pictures or audio failed:", error instanceof Error ? error.message : error);
							return [];
						})
				: [];
		return segments.map((segment) => {
			if (!isMedia(segment)) return segment;
			const { media: _, ...rest } = segment;
			return { ...rest, hash: `${version}:${segment.key}`, vector: vectors[media.indexOf(segment)] };
		});
	}

	private async embedWaiting(index: WorkspaceIndex): Promise<void> {
		const embedder = this.embedder;
		if (!embedder?.ready()) return;
		for (let batch = index.waiting(64); batch.length > 0; batch = index.waiting(64)) {
			const vectors = await embedder.embed(batch.map((segment) => documentPrompt(segment.text, segment.title)));
			index.storeVectors(batch.map((segment, position) => ({ id: segment.id, vector: vectors[position]! })));
		}
	}

	private index(workspaceId: string): WorkspaceIndex {
		let index = this.indexes.get(workspaceId);
		if (!index) {
			const directory = this.workspaceDirectory(workspaceId);
			mkdirSync(directory, { recursive: true });
			index = new WorkspaceIndex(join(directory, "index.sqlite"), this.embedder?.fingerprint ?? "keywords");
			this.indexes.set(workspaceId, index);
		}
		return index;
	}

	private workspaceDirectory(workspaceId: string): string {
		// Ids come from the database, but a path must never leave the workspaces folder.
		if (!/^[\w-]+$/.test(workspaceId)) throw new Error(`Invalid workspace id: ${workspaceId}`);
		return join(this.dataDirectory, "workspaces", workspaceId);
	}
}

function versionOf(...paths: string[]): string | null {
	const stats = paths.map((path) => statSync(path, { throwIfNoEntry: false }));
	if (!stats[0]) return null;
	return stats.map((stat) => (stat ? `${stat.mtimeMs}:${stat.size}` : "-")).join("/");
}

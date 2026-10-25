import { Database } from "bun:sqlite";
import { DIMENSIONS, fromBlob, toBlob } from "./embedder.ts";

/**
 * One workspace's search index: `data/workspaces/<workspace>/index.sqlite`. Derived data; deleting it re-indexes.
 * Sources (a thread, a file) are split into segments. Each segment has keywords in FTS5 and, when it reads as prose,
 * a 768 × float16 L2-normalized EmbeddingGemma 2 vector compared by brute force. Ranking follows DigUp
 * (github.com/ARahim3/DigUp, MIT): a per-query z-score of meaning plus keyword coverage.
 */
export type SourceInput = {
	readonly uri: string;
	readonly kind: SearchKind;
	readonly title: string;
	readonly threadId?: string;
	readonly channelId?: string;
	/** Changes when the source changes; an unchanged version skips re-reading it. */
	readonly version: string;
	readonly updatedAt: number;
};

export type SearchKind = "thread" | "note" | "file" | "capture";
export type Modality = "text" | "image" | "audio" | "none";
export type Segment = {
	readonly key: string;
	readonly text: string;
	/** `text` is embedded when it reads as prose, `none` is keywords only; pictures and audio come with their vector. */
	readonly modality?: Modality;
	readonly vector?: Float32Array;
	/** A page number, or a start second. */
	readonly loc?: number;
	readonly locEnd?: number;
	/** Identifies the content when `text` does not, as for media. */
	readonly hash?: string;
};

export type SearchResult = {
	readonly uri: string;
	readonly kind: SearchKind;
	readonly title: string;
	readonly threadId: string | null;
	readonly channelId: string | null;
	readonly snippet: string;
	/** What matched: text, a picture, a page scan, or a stretch of audio. */
	readonly modality: Modality;
	readonly loc: number | null;
	readonly score: number;
	readonly updatedAt: number;
};

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS sources (
		id INTEGER PRIMARY KEY,
		uri TEXT NOT NULL UNIQUE,      -- thread:<id>, or <folder>/<path> under the workspace folder
		kind TEXT NOT NULL,            -- thread | note | file | capture
		title TEXT NOT NULL,
		thread_id TEXT,
		channel_id TEXT,
		version TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS segments (
		id INTEGER PRIMARY KEY,
		source INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
		key TEXT NOT NULL,             -- stable within its source, such as a message id and chunk number
		hash TEXT NOT NULL,            -- of the content; unchanged content keeps its vector
		modality TEXT NOT NULL,        -- text | image | audio | none (keywords only)
		loc REAL,                      -- page number, or start second
		loc_end REAL,
		excerpt TEXT NOT NULL,
		embed INTEGER NOT NULL,        -- 1 while a text segment waits for a vector
		vec BLOB,                      -- 768 × float16, L2-normalized
		UNIQUE (source, key)
	);
	CREATE INDEX IF NOT EXISTS segments_embed ON segments (embed) WHERE embed = 1;
	CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5 (name, body, tokenize = "porter unicode61 remove_diacritics 2");
`;

const SCHEMA_VERSION = "2";
/**
 * Too few vectors give no meaningful spread; until then, assume typical EmbeddingGemma 2 scores, measured per kind:
 * a related text scored 0.80 against 0.58 for an unrelated one, the right photo 0.70-0.76 against 0.52-0.56 for an
 * unrelated query, related speech 0.80 against 0.57.
 */
const PRIOR_MINIMUM = 50;
const PRIORS: Record<Modality, { mean: number; deviation: number }> = {
	text: { mean: 0.55, deviation: 0.08 },
	image: { mean: 0.56, deviation: 0.06 },
	audio: { mean: 0.55, deviation: 0.08 },
	none: { mean: 0.55, deviation: 0.08 },
};
const MODALITIES: readonly Modality[] = ["text", "image", "audio", "none"];
const Z_GATE = 2;
const COVERAGE_GATE = 0.5;
const STOPWORDS = new Set("a an and are as at be by for from has have i in is it me my of on or our the to was we what when where which who with you".split(" "));

export class WorkspaceIndex {
	private readonly database: Database;
	private vectors: { ids: Int32Array; sources: Int32Array; modalities: Uint8Array; matrix: Float32Array } | null = null;

	constructor(path: string, fingerprint: string) {
		this.database = new Database(path, { create: true, strict: true });
		this.database.run("PRAGMA journal_mode = WAL");
		this.database.run("PRAGMA foreign_keys = ON");
		this.database.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const schema = this.database.query("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | null;
		if (schema?.value !== SCHEMA_VERSION) {
			// The index is derived: a new layout starts over, and the next scan fills it again.
			this.database.run("DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS segments; DROP TABLE IF EXISTS sources; DELETE FROM meta;");
			this.database.query("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
		}
		this.database.run(SCHEMA);
		const stored = this.database.query("SELECT value FROM meta WHERE key = 'fingerprint'").get() as { value: string } | null;
		if (stored?.value !== fingerprint) {
			// A different model or runtime makes other vectors: embed text again, and read media files again.
			this.database.transaction(() => {
				this.database.run("UPDATE segments SET vec = NULL, embed = 1 WHERE modality = 'text' AND (vec IS NOT NULL OR embed = 1)");
				this.database.run("UPDATE sources SET version = 'model changed' WHERE id IN (SELECT source FROM segments WHERE modality IN ('image', 'audio'))");
				this.database.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('fingerprint', ?)").run(fingerprint);
			})();
		}
	}

	/** Re-reads a source when its version changed: new or edited segments get re-embedded, unchanged ones keep their vector. */
	/** `extract` reads the source: its segments, and a better title when the content has one. */
	async sync(source: SourceInput, extract: () => Promise<{ readonly title?: string; readonly segments: readonly Segment[] }>): Promise<void> {
		const existing = this.database.query("SELECT id, version FROM sources WHERE uri = ?").get(source.uri) as
			| { id: number; version: string }
			| null;
		if (existing?.version === source.version) return;
		const extracted = await extract();
		const segments = extracted.segments;
		const title = extracted.title ?? source.title;
		// Media without a vector (the model was not running yet) is read again by a later scan.
		const waitingMedia = segments.some((segment) => (segment.modality === "image" || segment.modality === "audio") && !segment.vector);
		const version = waitingMedia ? `waiting for the model: ${source.version}` : source.version;
		this.database.transaction(() => {
			const id = existing
				? (this.database
						.query("UPDATE sources SET kind = ?, title = ?, thread_id = ?, channel_id = ?, version = ?, updated_at = ? WHERE id = ? RETURNING id")
						.get(source.kind, title, source.threadId ?? null, source.channelId ?? null, version, source.updatedAt, existing.id) as { id: number }).id
				: (this.database
						.query("INSERT INTO sources (uri, kind, title, thread_id, channel_id, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
						.get(source.uri, source.kind, title, source.threadId ?? null, source.channelId ?? null, version, source.updatedAt) as { id: number }).id;
			const old = new Map(
				(this.database.query("SELECT id, key, hash FROM segments WHERE source = ?").all(id) as { id: number; key: string; hash: string }[]).map(
					(row) => [row.key, row],
				),
			);
			for (const segment of segments) {
				const modality = segment.modality ?? "text";
				const media = modality === "image" || modality === "audio";
				const hash = segment.hash ?? Bun.hash(segment.text).toString(36);
				const previous = old.get(segment.key);
				old.delete(segment.key);
				if (previous?.hash === hash && !(media && segment.vector)) {
					this.database.query("UPDATE fts SET name = ? WHERE rowid = ?").run(title, previous.id);
					continue;
				}
				if (previous) this.deleteSegment(previous.id);
				const embed = modality === "text" && isProse(segment.text) ? 1 : 0;
				const { id: segmentId } = this.database
					.query("INSERT INTO segments (source, key, hash, modality, loc, loc_end, excerpt, embed, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
					.get(id, segment.key, hash, modality, segment.loc ?? null, segment.locEnd ?? null, segment.text, embed, segment.vector ? toBlob(segment.vector) : null) as { id: number };
				// Media labels such as "Page 3" carry no words worth matching; the title still finds the file.
				this.database.query("INSERT INTO fts (rowid, name, body) VALUES (?, ?, ?)").run(segmentId, title, media ? "" : segment.text);
			}
			for (const gone of old.values()) this.deleteSegment(gone.id);
		})();
		this.vectors = null;
	}

	/** Removes sources that no longer exist; `keep` holds the uris seen in this scan. */
	prune(keep: ReadonlySet<string>): void {
		const stale = (this.database.query("SELECT id, uri FROM sources").all() as { id: number; uri: string }[]).filter((row) => !keep.has(row.uri));
		if (stale.length === 0) return;
		this.database.transaction(() => {
			for (const row of stale) {
				this.database.query("DELETE FROM fts WHERE rowid IN (SELECT id FROM segments WHERE source = ?)").run(row.id);
				this.database.query("DELETE FROM sources WHERE id = ?").run(row.id);
			}
		})();
		this.vectors = null;
	}

	/** Segments that wait for a vector, with the title for the document prompt. */
	waiting(limit: number): { id: number; title: string; text: string }[] {
		return this.database
			.query("SELECT s.id, src.title, s.excerpt AS text FROM segments s JOIN sources src ON src.id = s.source WHERE s.embed = 1 LIMIT ?")
			.all(limit) as { id: number; title: string; text: string }[];
	}

	storeVectors(vectors: readonly { id: number; vector: Float32Array }[]): void {
		this.database.transaction(() => {
			for (const { id, vector } of vectors) this.database.query("UPDATE segments SET vec = ?, embed = 0 WHERE id = ?").run(toBlob(vector), id);
		})();
		this.vectors = null;
	}

	/** Ranks sources by meaning (when `queryVector` is given) and keywords; best first. */
	search(query: string, queryVector: Float32Array | null, limit: number): SearchResult[] {
		const terms = queryTerms(query);
		const keywords = this.keywordHits(terms);
		const meaning = queryVector ? this.meaningHits(queryVector) : new Map<number, { z: number; segment: number }>();
		const lookup = terms.length > 0 && terms.every((term) => /\d/.test(term) && (/\p{L}/u.test(term) || term.length >= 4));
		const [meaningWeight, wordWeight] = lookup ? [0.5, 4] : [1, 2];
		const scored: { source: number; score: number; segment: number }[] = [];
		for (const source of new Set([...keywords.keys(), ...meaning.keys()])) {
			const words = keywords.get(source);
			const sense = meaning.get(source);
			const coverage = words?.coverage ?? 0;
			const z = sense?.z ?? 0;
			// Without vectors, any keyword hit counts; with them, DigUp's gates keep weak matches out.
			const candidate = queryVector ? z >= Z_GATE || coverage >= COVERAGE_GATE : coverage > 0;
			if (!candidate) continue;
			const segment = sense && sense.z >= Z_GATE ? sense.segment : (words?.segment ?? sense!.segment);
			scored.push({ source, score: meaningWeight * Math.max(z, 0) + wordWeight * coverage ** 1.5, segment });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit).map(({ source, score, segment }) => {
			const row = this.database
				.query(
					"SELECT src.uri, src.kind, src.title, src.thread_id AS threadId, src.channel_id AS channelId, src.updated_at AS updatedAt, s.excerpt, s.modality, s.loc FROM sources src JOIN segments s ON s.id = ? WHERE src.id = ?",
				)
				.get(segment, source) as Omit<SearchResult, "snippet" | "score"> & { excerpt: string };
			const { excerpt, ...result } = row;
			return { ...result, snippet: snippet(excerpt, terms), score };
		});
	}

	counts(): { sources: number; segments: number; waiting: number } {
		return this.database
			.query("SELECT (SELECT count(*) FROM sources) AS sources, (SELECT count(*) FROM segments) AS segments, (SELECT count(*) FROM segments WHERE embed = 1) AS waiting")
			.get() as { sources: number; segments: number; waiting: number };
	}

	close(): void {
		this.database.close();
	}

	private deleteSegment(id: number): void {
		this.database.query("DELETE FROM fts WHERE rowid = ?").run(id);
		this.database.query("DELETE FROM segments WHERE id = ?").run(id);
	}

	/** Per source: the share of query terms it contains, and its best-matching segment. */
	private keywordHits(terms: readonly string[]): Map<number, { coverage: number; segment: number }> {
		const hits = new Map<number, { coverage: number; segment: number }>();
		if (terms.length === 0) return hits;
		const match = terms.map(ftsTerm).join(" OR ");
		const ranked = this.database
			.query("SELECT s.source, s.id FROM fts JOIN segments s ON s.id = fts.rowid WHERE fts MATCH ? ORDER BY bm25(fts, 3.0, 1.0) LIMIT 1000")
			.all(match) as { source: number; id: number }[];
		for (const row of ranked) if (!hits.has(row.source)) hits.set(row.source, { coverage: 0, segment: row.id });
		for (const term of terms) {
			const sources = this.database
				.query("SELECT DISTINCT s.source FROM fts JOIN segments s ON s.id = fts.rowid WHERE fts MATCH ?")
				.all(ftsTerm(term)) as { source: number }[];
			for (const { source } of sources) {
				const hit = hits.get(source);
				if (hit) hit.coverage += 1 / terms.length;
			}
		}
		return hits;
	}

	/**
	 * Per source: the best z-score of cosine similarity against all vectors, by brute force. Text, pictures, and audio
	 * score on different scales, so each is centered on its own mean (DigUp does the same).
	 */
	private meaningHits(query: Float32Array): Map<number, { z: number; segment: number }> {
		const { ids, sources, modalities, matrix } = this.loadVectors();
		const hits = new Map<number, { z: number; segment: number }>();
		const count = ids.length;
		if (count === 0) return hits;
		const scores = new Float32Array(count);
		const sums = new Float64Array(MODALITIES.length);
		const counts = new Uint32Array(MODALITIES.length);
		let total = 0;
		for (let row = 0; row < count; row++) {
			let dot = 0;
			const offset = row * DIMENSIONS;
			for (let column = 0; column < DIMENSIONS; column++) dot += matrix[offset + column]! * query[column]!;
			scores[row] = dot;
			sums[modalities[row]!]! += dot;
			counts[modalities[row]!]!++;
			total += dot;
		}
		// shortcut: fixed priors for small indexes, until there are enough vectors to measure the spread.
		const measured = count >= PRIOR_MINIMUM;
		const means = MODALITIES.map((modality, index) =>
			!measured ? PRIORS[modality].mean : counts[index]! >= 20 ? sums[index]! / counts[index]! : total / count,
		);
		let variance = 0;
		for (let row = 0; row < count; row++) variance += (scores[row]! - means[modalities[row]!]!) ** 2;
		const spread = Math.max(Math.sqrt(variance / count), 0.02);
		for (let row = 0; row < count; row++) {
			const deviation = measured ? spread : PRIORS[MODALITIES[modalities[row]!]!].deviation;
			const z = (scores[row]! - means[modalities[row]!]!) / deviation;
			const source = sources[row]!;
			const best = hits.get(source);
			if (!best || z > best.z) hits.set(source, { z, segment: ids[row]! });
		}
		return hits;
	}

	/** All vectors as one float32 matrix, kept until the index changes. */
	private loadVectors() {
		if (this.vectors) return this.vectors;
		const rows = this.database.query("SELECT id, source, modality, vec FROM segments WHERE vec IS NOT NULL").all() as {
			id: number;
			source: number;
			modality: Modality;
			vec: Uint8Array;
		}[];
		const matrix = new Float32Array(rows.length * DIMENSIONS);
		rows.forEach((row, index) => matrix.set(fromBlob(row.vec), index * DIMENSIONS));
		this.vectors = {
			ids: Int32Array.from(rows, (row) => row.id),
			sources: Int32Array.from(rows, (row) => row.source),
			modalities: Uint8Array.from(rows, (row) => MODALITIES.indexOf(row.modality)),
			matrix,
		};
		return this.vectors;
	}
}

/** Text is embedded only when it reads as prose: at least four words and a fifth letters. */
export function isProse(text: string): boolean {
	const letters = text.match(/\p{L}/gu)?.length ?? 0;
	const words = text.match(/\p{L}{2,}/gu)?.length ?? 0;
	return words >= 4 && letters >= text.length * 0.2;
}

/** Splits text into chunks of about 1800 characters with 200 characters of overlap, breaking at whitespace. */
export function chunk(text: string, size = 1800, overlap = 200): string[] {
	const clean = text.trim();
	if (clean.length <= size) return clean ? [clean] : [];
	const chunks: string[] = [];
	let start = 0;
	while (start < clean.length) {
		let end = Math.min(start + size, clean.length);
		if (end < clean.length) {
			const space = clean.lastIndexOf(" ", end);
			const newline = clean.lastIndexOf("\n", end);
			const cut = Math.max(space, newline);
			if (cut > start + size / 2) end = cut;
		}
		chunks.push(clean.slice(start, end).trim());
		if (end >= clean.length) break;
		start = end - overlap;
	}
	return chunks;
}

function queryTerms(query: string): string[] {
	return [...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((term) => !STOPWORDS.has(term));
}

function ftsTerm(term: string): string {
	// Terms of three or more characters also match words that start with them, as while typing.
	return term.length >= 3 ? `"${term}"*` : `"${term}"`;
}

/** About 200 characters of the excerpt around the first query term. */
function snippet(excerpt: string, terms: readonly string[]): string {
	const text = excerpt.replace(/\s+/g, " ").trim();
	if (text.length <= 200) return text;
	const lower = text.toLowerCase();
	const at = Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0), text.length);
	const start = at === text.length ? 0 : Math.max(0, at - 60);
	return `${start > 0 ? "…" : ""}${text.slice(start, start + 200).trim()}${start + 200 < text.length ? "…" : ""}`;
}

import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** A private, self-contained replay record. It never contains credential secrets. */
export class Audit {
  readonly database: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    this.database = new Database(path, { create: true, strict: true });
    this.database.run(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000"
    );
    this.database.run(`CREATE TABLE IF NOT EXISTS event (
      id INTEGER PRIMARY KEY, trace TEXT NOT NULL, stage TEXT NOT NULL,
      workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS event_trace ON event(trace,id);
    CREATE TABLE IF NOT EXISTS blob (hash TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BLOB NOT NULL);`);
    const root = resolve(import.meta.dir, "..");
    const sources = readdirSync(root, { recursive: true })
      .filter(
        (name) =>
          typeof name === "string" &&
          name.endsWith(".ts") &&
          !name.endsWith(".test.ts")
      )
      .sort()
      .map((name) => {
        const file = join(root, String(name));
        return {
          path: relative(root, file),
          sha256: new Bun.CryptoHasher("sha256")
            .update(readFileSync(file))
            .digest("hex"),
        };
      });
    this.record("runtime", "audit.open", "", "", {
      format: 1,
      bun: Bun.version,
      sources,
    });
  }

  record(
    trace: string,
    stage: string,
    workspaceId: string,
    ownerId: string,
    data: unknown,
    at = Date.now()
  ): void {
    this.database
      .query(
        "INSERT INTO event(trace,stage,workspace_id,owner_id,at,data) VALUES(?,?,?,?,?,?)"
      )
      .run(trace, stage, workspaceId, ownerId, at, JSON.stringify(data));
  }

  blob(bytes: Uint8Array, type: string): string {
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    this.database
      .query("INSERT OR IGNORE INTO blob VALUES(?,?,?)")
      .run(hash, type, bytes);
    return hash;
  }

  last(
    trace: string,
    stage: string,
    workspaceId: string,
    ownerId: string
  ): unknown {
    const row = this.database
      .query(
        "SELECT data FROM event WHERE trace=? AND stage=? AND workspace_id=? AND owner_id=? ORDER BY id DESC LIMIT 1"
      )
      .get(trace, stage, workspaceId, ownerId) as { data: string } | null;
    return row ? JSON.parse(row.data) : undefined;
  }

  close(): void {
    this.database.close();
  }
}

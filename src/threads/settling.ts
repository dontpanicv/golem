import { Database } from "bun:sqlite";

const DAY_MS = 24 * 60 * 60_000;

/** The daily check time of one workspace, in its memory database. */
export class Settling {
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
    this.database.run("PRAGMA journal_mode = WAL");
    this.database.run(`CREATE TABLE IF NOT EXISTS settling_check (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      checked_at INTEGER NOT NULL
    )`);
  }

  /** Claims at most one check in 24 hours, including across restarts. */
  claim(now: number): boolean {
    return (
      this.database
        .query(`
      INSERT INTO settling_check (id, checked_at) VALUES (1, ?)
      ON CONFLICT (id) DO UPDATE SET checked_at = excluded.checked_at
      WHERE checked_at <= excluded.checked_at - ?
    `)
        .run(now, DAY_MS).changes === 1
    );
  }

  close(): void {
    this.database.close();
  }
}

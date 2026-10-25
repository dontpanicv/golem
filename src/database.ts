import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Application tables. better-auth owns `user`, `session`, `account`, `verification`, `organization` (workspaces),
 * `member`, and `invitation`; it migrates them itself. Append a migration; never edit one that shipped.
 */
const migrations = [
  `CREATE TABLE channel (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		name TEXT NOT NULL,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		UNIQUE (workspace_id, name)
	);
	CREATE TABLE thread (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		channel_id TEXT NOT NULL REFERENCES channel (id) ON DELETE CASCADE,
		title TEXT NOT NULL,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX thread_channel ON thread (channel_id, updated_at);
	CREATE TABLE credential (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		integration TEXT NOT NULL,
		owner_id TEXT NOT NULL,
		label TEXT NOT NULL,
		shared INTEGER NOT NULL,
		secret BLOB NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX credential_workspace ON credential (workspace_id, integration);
	CREATE TABLE integration_setting (
		workspace_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		integration TEXT NOT NULL,
		enabled INTEGER NOT NULL,
		PRIMARY KEY (workspace_id, user_id, integration)
	);
	CREATE TABLE provider_credential (
		provider_id TEXT PRIMARY KEY,
		secret BLOB NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE setting (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);`,
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const database = new Database(path, { create: true, strict: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA foreign_keys = ON");
  database.run("PRAGMA busy_timeout = 5000");
  return database;
}

/** Runs the application migrations that this database has not run yet. */
export function migrate(database: Database): void {
  const { user_version: version } = database
    .query("PRAGMA user_version")
    .get() as { user_version: number };
  for (const [index, sql] of migrations.entries()) {
    if (index < version) {
      continue;
    }
    database.transaction(() => {
      database.run(sql);
      database.run(`PRAGMA user_version = ${index + 1}`);
    })();
  }
}

export function setting(database: Database, key: string): string | undefined {
  return (
    database.query("SELECT value FROM setting WHERE key = ?").get(key) as {
      value: string;
    } | null
  )?.value;
}

export function setSetting(
  database: Database,
  key: string,
  value: string
): void {
  database
    .query(
      "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}

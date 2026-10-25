import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Application tables. better-auth owns `user`, `session`, `account`, `verification`, `organization` (workspaces),
 * `member`, and `invitation`; it migrates them itself. Append a migration; never edit one that shipped.
 *
 * Each table has one owner module, and only that module queries it: `workspaces` owns `channel` and `thread` (and reads
 * `organization` and `member`), `integrations` owns `credential` and `integration_setting` (no longer read), `llm` owns
 * `provider_credential` and its keys in `setting`, `hands` owns `machine`, `artifacts` owns `artifact`,
 * `artifact_visitor`, and `artifact_record`, and `routines` owns `routine` and `routine_run`. Start a new migration
 * with a comment that names its owner.
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
  // workspaces: a thread is one conversation in its workspace's session.sqlite. Threads from before kept a session
  // file each; their rows go, and their files stay on disk.
  `ALTER TABLE thread ADD COLUMN conversation_id INTEGER;
	DELETE FROM thread WHERE conversation_id IS NULL;`,
  // hands: the machines paired with a workspace. `addresses` is a JSON array.
  `CREATE TABLE machine (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		name TEXT NOT NULL,
		hostname TEXT,
		addresses TEXT NOT NULL,
		port INTEGER NOT NULL,
		cert_sha256 TEXT NOT NULL,
		os TEXT NOT NULL,
		arch TEXT NOT NULL,
		version TEXT NOT NULL,
		paired_at INTEGER NOT NULL,
		UNIQUE (workspace_id, cert_sha256),
		UNIQUE (workspace_id, name)
	);`,
  // workspaces: what a channel is for and what goes on in it, as an agent last wrote it.
  "ALTER TABLE channel ADD COLUMN summary TEXT;",
  // routines: the scheduled work of a channel. `schedule` is a cron expression in the server's time zone, `script`
  // runs in code mode (null: the agent does the work), and `store` is the JSON the script keeps between runs.
  `CREATE TABLE routine (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		channel_id TEXT NOT NULL REFERENCES channel (id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		schedule TEXT NOT NULL,
		instructions TEXT NOT NULL,
		script TEXT,
		store TEXT NOT NULL,
		enabled INTEGER NOT NULL,
		next_run_at INTEGER,
		thread_id TEXT,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX routine_channel ON routine (channel_id);
	CREATE TABLE routine_run (
		id TEXT PRIMARY KEY,
		routine_id TEXT NOT NULL REFERENCES routine (id) ON DELETE CASCADE,
		started_at INTEGER NOT NULL,
		finished_at INTEGER,
		outcome TEXT NOT NULL,
		error TEXT
	);
	CREATE INDEX routine_run_routine ON routine_run (routine_id, started_at);`,
  // artifacts: the pages and small apps agents make in a thread, and the data their visitors keep. `visibility` is
  // `public` or `members`; `request_key` lets a create that a crash repeats find the artifact it made. A record's
  // `scope` is `shared` or the visitor that owns it, and `value` is JSON.
  `CREATE TABLE artifact (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		thread_id TEXT NOT NULL REFERENCES thread (id) ON DELETE CASCADE,
		title TEXT NOT NULL,
		html TEXT NOT NULL,
		visibility TEXT NOT NULL,
		request_key TEXT UNIQUE,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX artifact_thread ON artifact (thread_id);
	CREATE TABLE artifact_visitor (
		artifact_id TEXT NOT NULL REFERENCES artifact (id) ON DELETE CASCADE,
		visitor TEXT NOT NULL,
		name TEXT,
		seen_at INTEGER NOT NULL,
		PRIMARY KEY (artifact_id, visitor)
	);
	CREATE TABLE artifact_record (
		artifact_id TEXT NOT NULL REFERENCES artifact (id) ON DELETE CASCADE,
		scope TEXT NOT NULL,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (artifact_id, scope, key)
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

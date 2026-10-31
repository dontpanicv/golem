import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Application tables. better-auth owns `user`, `session`, `account`, `verification`, `organization` (workspaces),
 * `member`, and `invitation`; it migrates them itself. Append a migration; never edit one that shipped.
 *
 * Each table has one owner module, and only that module queries it: `workspaces` owns `channel`, `thread`, and `workspace_facts` (and reads
 * `organization` and `member`, and writes the name and `deletedAt` of an `organization`), `integrations` owns
 * `credential`, `oauth_client`, and `integration_setting` (no longer read), `llm` owns `provider_credential` and its keys in `setting`,
 * `hands` owns `machine`, `artifacts` owns `artifact`, `artifact_name`, `artifact_visitor`, and `artifact_record`,
 * `routines` owns `routine` and `routine_run`, `reminders` owns `reminder`, and `notifications` owns `notification` and
 * `push_device`. Start a new migration with a comment that names its owner.
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
  // artifacts: every name an artifact had, such as `amber-fox`; names stay after their artifact goes, so they are
  // never given out again.
  `CREATE TABLE artifact_name (id TEXT PRIMARY KEY);
	INSERT INTO artifact_name (id) SELECT id FROM artifact;`,
  // workspaces: keep finished threads available without showing them among active threads.
  "ALTER TABLE thread ADD COLUMN settled_at INTEGER;",
  // workspaces: the one thread of a workspace that never ends and that nobody settles. It is in the first channel,
  // which channel lists leave it out of.
  `ALTER TABLE thread ADD COLUMN orchestrator INTEGER NOT NULL DEFAULT 0;
	CREATE UNIQUE INDEX thread_orchestrator ON thread (workspace_id) WHERE orchestrator = 1;`,
  // Deletes are soft: a deleted row keeps everything and gets `deleted_at`, and reads leave it out.
  // workspaces: a deleted channel hides its threads; its name gets `~<id>`, so a new channel can take the name.
  "ALTER TABLE channel ADD COLUMN deleted_at INTEGER;",
  // artifacts: deleted artifacts, records, and visitors.
  `ALTER TABLE artifact ADD COLUMN deleted_at INTEGER;
	ALTER TABLE artifact_record ADD COLUMN deleted_at INTEGER;
	ALTER TABLE artifact_visitor ADD COLUMN deleted_at INTEGER;`,
  // routines: deleted routines, which never run again.
  "ALTER TABLE routine ADD COLUMN deleted_at INTEGER;",
  // hands: removed machines; their name and certificate get `~<id>`, so the machine can pair again.
  "ALTER TABLE machine ADD COLUMN deleted_at INTEGER;",
  // integrations: deleted credentials, which no tool uses again.
  "ALTER TABLE credential ADD COLUMN deleted_at INTEGER;",
  // llm: the login of a provider after a logout, which nothing reads again.
  "ALTER TABLE provider_credential ADD COLUMN deleted_at INTEGER;",
  // artifacts: an artifact belongs to its channel and stays after its thread is settled; `thread_id` is the thread
  // that made it. The orchestrator's belong to the workspace: their `channel_id` is null.
  `ALTER TABLE artifact ADD COLUMN channel_id TEXT;
	UPDATE artifact SET channel_id = (SELECT CASE WHEN orchestrator = 1 THEN NULL ELSE channel_id END FROM thread WHERE thread.id = artifact.thread_id);
	CREATE INDEX artifact_channel ON artifact (channel_id);`,
  // reminders: one due time, tied to the person and thread that asked for it.
  `CREATE TABLE reminder (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		thread_id TEXT NOT NULL,
		recipient_id TEXT NOT NULL,
		text TEXT NOT NULL,
		due_at INTEGER NOT NULL,
		time_zone TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER NOT NULL,
		last_error TEXT,
		delivered_at INTEGER,
		cancelled_at INTEGER,
		deleted_at INTEGER,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX reminder_due ON reminder (next_attempt_at) WHERE delivered_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL;
	CREATE INDEX reminder_workspace ON reminder (workspace_id, due_at);`,
  // notifications: what needs a person's attention, which opens a thread or a channel, and the devices that get pushes.
  `CREATE TABLE notification (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		thread_id TEXT,
		title TEXT NOT NULL,
		text TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		read_at INTEGER
	);
	CREATE INDEX notification_inbox ON notification (user_id, workspace_id, created_at);
	CREATE TABLE push_device (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		token TEXT NOT NULL,
		environment TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		deleted_at INTEGER
	);
	CREATE INDEX push_device_user ON push_device (user_id) WHERE deleted_at IS NULL;`,
  // integrations: a credential without a workspace is its owner's own, for their turns in each of their workspaces.
  // SQLite cannot drop NOT NULL from a column, so the table is made again with the same rows.
  `CREATE TABLE credential_next (
		id TEXT PRIMARY KEY,
		workspace_id TEXT,
		integration TEXT NOT NULL,
		owner_id TEXT NOT NULL,
		label TEXT NOT NULL,
		shared INTEGER NOT NULL,
		secret BLOB NOT NULL,
		created_at INTEGER NOT NULL,
		deleted_at INTEGER
	);
	INSERT INTO credential_next SELECT id, workspace_id, integration, owner_id, label, shared, secret, created_at, deleted_at FROM credential;
	DROP TABLE credential;
	ALTER TABLE credential_next RENAME TO credential;
	CREATE INDEX credential_workspace ON credential (workspace_id, integration);
	CREATE INDEX credential_owner ON credential (owner_id, integration) WHERE workspace_id IS NULL;`,
  // reminders: the person who asked for a reminder or last changed it; its turn runs as them. Null for older rows.
  "ALTER TABLE reminder ADD COLUMN created_by TEXT;",
  // hands: the member who paired a machine, who allows what agents do on it for others.
  "ALTER TABLE machine ADD COLUMN paired_by TEXT;",
  // hands: a machine without a workspace is the own machine of the person who paired it, for their turns in each of
  // their workspaces. SQLite cannot drop NOT NULL from a column, so the table is made again with the same rows.
  `CREATE TABLE machine_next (
		id TEXT PRIMARY KEY,
		workspace_id TEXT,
		name TEXT NOT NULL,
		hostname TEXT,
		addresses TEXT NOT NULL,
		port INTEGER NOT NULL,
		cert_sha256 TEXT NOT NULL,
		os TEXT NOT NULL,
		arch TEXT NOT NULL,
		version TEXT NOT NULL,
		paired_at INTEGER NOT NULL,
		deleted_at INTEGER,
		paired_by TEXT,
		UNIQUE (workspace_id, cert_sha256),
		UNIQUE (workspace_id, name)
	);
	INSERT INTO machine_next SELECT id, workspace_id, name, hostname, addresses, port, cert_sha256, os, arch, version, paired_at, deleted_at, paired_by FROM machine;
	DROP TABLE machine;
	ALTER TABLE machine_next RENAME TO machine;
	CREATE UNIQUE INDEX machine_own_cert ON machine (paired_by, cert_sha256) WHERE workspace_id IS NULL;
	CREATE UNIQUE INDEX machine_own_name ON machine (paired_by, name) WHERE workspace_id IS NULL;`,
  // routines: what a run's script found, kept until the run ends, so a run that a stop cuts off goes on with it.
  "ALTER TABLE routine_run ADD COLUMN result TEXT;",
  // hands and routines: standing approvals, unused since dcg alone decides what waits for a person; drop both.
  "ALTER TABLE machine ADD COLUMN trusted_members TEXT NOT NULL DEFAULT '[]';",
  "ALTER TABLE routine ADD COLUMN machine_ids TEXT NOT NULL DEFAULT '[]';",
  // workspaces: each member has an orchestrator of their own, and its `created_by` is that member. The workspace's one
  // orchestrator from before becomes the own of the person who made the workspace, who made its first channel.
  `UPDATE thread SET created_by = (SELECT c.created_by FROM channel c WHERE c.workspace_id = thread.workspace_id ORDER BY c.created_at, c.rowid LIMIT 1) WHERE orchestrator = 1;
	DROP INDEX thread_orchestrator;
	CREATE UNIQUE INDEX thread_own_orchestrator ON thread (workspace_id, created_by) WHERE orchestrator = 1;`,
  // integrations: Golem's own OAuth client of an integration whose sign-in server does not register clients, such as
  // Google's; the server's owner sets it in Settings. `secret` is the encrypted client secret.
  `CREATE TABLE oauth_client (
		integration TEXT PRIMARY KEY,
		client_id TEXT NOT NULL,
		secret BLOB NOT NULL,
		changed_by TEXT NOT NULL,
		changed_at INTEGER NOT NULL
	);`,
  // workspaces: the emoji that the model chose for a channel, which people see before its name.
  "ALTER TABLE channel ADD COLUMN icon TEXT;",
  // workspaces: the facts that the people of a workspace write by hand, such as names, birthdays, and places.
  `CREATE TABLE workspace_facts (
		workspace_id TEXT PRIMARY KEY,
		text TEXT NOT NULL,
		changed_by TEXT NOT NULL,
		changed_at INTEGER NOT NULL
	);`,
  // workspaces: a private channel belongs to one member, who alone sees it, its threads, files, artifacts, and
  // routines; `owner_id` is null for a channel every member sees.
  "ALTER TABLE channel ADD COLUMN owner_id TEXT;",
  // search: what each person searched in a workspace, which the search page shows before a query.
  `CREATE TABLE recent_search (
		workspace_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		query TEXT NOT NULL COLLATE NOCASE,
		searched_at INTEGER NOT NULL,
		PRIMARY KEY (workspace_id, user_id, query)
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

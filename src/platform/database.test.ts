import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import { migrate } from "./database.ts";

test("the workspace's one orchestrator from before becomes the own of the person who made its first channel", () => {
  const database = authDatabase();
  migrate(database);
  const { user_version: version } = database
    .query("PRAGMA user_version")
    .get() as { user_version: number };
  // The state before the migration of the orchestrators and the one after it: one orchestrator of the workspace,
  // made by Golem, no OAuth clients, no channel emojis, no facts, no private channels, and no recent searches.
  database.run(`DROP TABLE recent_search;
	ALTER TABLE channel DROP COLUMN owner_id;
	DROP TABLE workspace_facts;
	ALTER TABLE channel DROP COLUMN icon;
	DROP TABLE oauth_client;
	DROP INDEX thread_own_orchestrator;
	CREATE UNIQUE INDEX thread_orchestrator ON thread (workspace_id) WHERE orchestrator = 1;
	INSERT INTO channel (id, workspace_id, name, created_by, created_at) VALUES ('general', 'home', 'general', 'alice', 1), ('food', 'home', 'food', 'bob', 2);
	INSERT INTO thread (id, workspace_id, channel_id, title, created_by, created_at, updated_at, orchestrator) VALUES ('golem', 'home', 'food', 'Golem', 'golem', 1, 1, 1), ('dinner', 'home', 'food', 'Dinner', 'bob', 1, 1, 0);
	PRAGMA user_version = ${version - 7};`);
  migrate(database);
  expect(
    database
      .query("SELECT id, created_by AS createdBy FROM thread ORDER BY id")
      .all()
  ).toEqual([
    { id: "dinner", createdBy: "bob" },
    { id: "golem", createdBy: "alice" },
  ]);
  database.run(
    "INSERT INTO thread (id, workspace_id, channel_id, title, created_by, created_at, updated_at, orchestrator) VALUES ('bobs', 'home', 'general', 'Golem', 'bob', 1, 1, 1)"
  );
  expect(() =>
    database.run(
      "INSERT INTO thread (id, workspace_id, channel_id, title, created_by, created_at, updated_at, orchestrator) VALUES ('again', 'home', 'general', 'Golem', 'bob', 1, 1, 1)"
    )
  ).toThrow();
});

test("own credentials and machines become private ones in their owner's workspace, and the workspace's shared ones", () => {
  const database = authDatabase();
  migrate(database);
  const { user_version: version } = database
    .query("PRAGMA user_version")
    .get() as { user_version: number };
  // The tables before: a null workspace is a person's own. Alice paired the NAS both ways, and Bob's own "mac" has the
  // name of Alice's.
  database.run(`DROP TABLE credential;
	DROP TABLE machine;
	CREATE TABLE credential (id TEXT PRIMARY KEY, workspace_id TEXT, integration TEXT NOT NULL, owner_id TEXT NOT NULL, label TEXT NOT NULL, shared INTEGER NOT NULL, secret BLOB NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER);
	CREATE TABLE machine (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT NOT NULL, hostname TEXT, addresses TEXT NOT NULL, port INTEGER NOT NULL, cert_sha256 TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL, version TEXT NOT NULL, paired_at INTEGER NOT NULL, deleted_at INTEGER, paired_by TEXT, trusted_members TEXT NOT NULL DEFAULT '[]', UNIQUE (workspace_id, cert_sha256), UNIQUE (workspace_id, name));
	INSERT INTO organization (id, name, createdAt, deletedAt) VALUES ('old', 'Old', 1, 5), ('home', 'Home', 2, NULL);
	INSERT INTO member (id, organizationId, userId) VALUES ('m1', 'old', 'alice'), ('m2', 'home', 'alice'), ('m3', 'home', 'bob');
	INSERT INTO channel (id, workspace_id, name, created_by, created_at) VALUES ('general', 'home', 'general', 'alice', 1);
	INSERT INTO credential (id, workspace_id, integration, owner_id, label, shared, secret, created_at) VALUES ('family-mail', 'home', 'google', 'bob', 'family', 1, x'00', 1), ('alices-mail', NULL, 'google', 'alice', 'alice', 1, x'00', 2);
	INSERT INTO machine (id, workspace_id, name, addresses, port, cert_sha256, os, arch, version, paired_at, paired_by) VALUES
		('old-nas', 'home', 'nas~old-nas', '[]', 1, 'n~old-nas', 'linux', 'x86_64', '1', 1, NULL),
		('shared-nas', 'home', 'nas', '[]', 1, 'n', 'linux', 'x86_64', '1', 2, 'alice'),
		('own-nas', NULL, 'nas', '[]', 1, 'n', 'linux', 'x86_64', '1', 3, 'alice'),
		('alices-mac', NULL, 'mac', '[]', 1, 'a', 'macos', 'arm64', '1', 4, 'alice'),
		('bobs-mac', NULL, 'mac', '[]', 1, 'b', 'macos', 'arm64', '1', 5, 'bob');
	UPDATE machine SET deleted_at = 1 WHERE id = 'old-nas';
	PRAGMA user_version = ${version - 1};`);
  migrate(database);
  expect(
    database
      .query(
        "SELECT id, workspace_id AS workspaceId, owner_id AS ownerId, shared FROM credential ORDER BY id"
      )
      .all()
  ).toEqual([
    { id: "alices-mail", workspaceId: "home", ownerId: "alice", shared: 0 },
    { id: "family-mail", workspaceId: "home", ownerId: "bob", shared: 1 },
  ]);
  expect(
    database
      .query(
        "SELECT id, workspace_id AS workspaceId, name, paired_by AS pairedBy, shared, deleted_at IS NOT NULL AS deleted FROM machine ORDER BY id"
      )
      .all()
  ).toEqual([
    {
      id: "alices-mac",
      workspaceId: "home",
      name: "mac",
      pairedBy: "alice",
      shared: 0,
      deleted: 0,
    },
    {
      id: "bobs-mac",
      workspaceId: "home",
      name: "mac-bobs",
      pairedBy: "bob",
      shared: 0,
      deleted: 0,
    },
    {
      id: "old-nas",
      workspaceId: "home",
      name: "nas~old-nas",
      pairedBy: "alice",
      shared: 1,
      deleted: 1,
    },
    {
      id: "own-nas",
      workspaceId: "home",
      name: "nas",
      pairedBy: "alice",
      shared: 1,
      deleted: 0,
    },
    {
      id: "shared-nas",
      workspaceId: "home",
      name: "nas~shared-nas",
      pairedBy: "alice",
      shared: 1,
      deleted: 1,
    },
  ]);
});

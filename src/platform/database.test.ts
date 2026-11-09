import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import { migrate } from "./database.ts";

/** Back to the names from before the migration that made channels topics and threads chats, as older databases have them. */
function undoTopicsAndChats(database: Database): void {
  database.run(`DROP TRIGGER intake_check_created;
  DROP TRIGGER intake_check_changed;
  DROP INDEX chat_topic;
  DROP INDEX routine_topic;
  DROP INDEX artifact_chat;
  DROP INDEX artifact_topic;
  DROP INDEX chat_own_orchestrator;
  ALTER TABLE topic RENAME TO channel;
  ALTER TABLE chat RENAME TO thread;
  ALTER TABLE intake_chat_read RENAME TO intake_thread_read;
  ALTER TABLE thread RENAME COLUMN topic_id TO channel_id;
  ALTER TABLE routine RENAME COLUMN topic_id TO channel_id;
  ALTER TABLE routine RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE artifact RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE artifact RENAME COLUMN topic_id TO channel_id;
  ALTER TABLE reminder RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE notification RENAME COLUMN topic_id TO channel_id;
  ALTER TABLE notification RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE llm_usage RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE suggestion RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE suggestion RENAME COLUMN topic_id TO channel_id;
  ALTER TABLE live_activity RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE feedback RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_item RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_check RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_context RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_delivery RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_thread_read RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_source_read RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_archive RENAME COLUMN topic_id TO channel_id;
  CREATE INDEX thread_channel ON thread (channel_id, updated_at);
  CREATE INDEX routine_channel ON routine (channel_id);
  CREATE INDEX artifact_thread ON artifact (thread_id);
  CREATE INDEX artifact_channel ON artifact (channel_id);
  CREATE UNIQUE INDEX thread_own_orchestrator ON thread (workspace_id, created_by) WHERE orchestrator = 1;
  CREATE TRIGGER intake_check_created AFTER INSERT ON intake_check BEGIN
    INSERT INTO intake_check_revision(check_id,workspace_id,owner_id,at,current)
    VALUES(NEW.id,NEW.workspace_id,NEW.owner_id,NEW.revised_at,json_object('text',NEW.text,'state',NEW.state,'sourceIds',json(NEW.source_ids),'threadId',NEW.thread_id,'checkAt',NEW.check_at,'reviewAt',NEW.next_review_at,'explicitTime',NEW.explicit_time,'notifiedAt',NEW.notified_at));
  END;
  CREATE TRIGGER intake_check_changed AFTER UPDATE ON intake_check
    WHEN OLD.text IS NOT NEW.text OR OLD.state IS NOT NEW.state OR OLD.source_ids IS NOT NEW.source_ids
      OR OLD.check_at IS NOT NEW.check_at OR OLD.next_review_at IS NOT NEW.next_review_at
      OR OLD.thread_id IS NOT NEW.thread_id OR OLD.explicit_time IS NOT NEW.explicit_time
      OR OLD.notified_at IS NOT NEW.notified_at
    BEGIN
    INSERT INTO intake_check_revision(check_id,workspace_id,owner_id,at,previous,current)
    VALUES(NEW.id,NEW.workspace_id,NEW.owner_id,CAST(unixepoch('subsec')*1000 AS INTEGER),json_object('text',OLD.text,'state',OLD.state,'sourceIds',json(OLD.source_ids),'threadId',OLD.thread_id,'checkAt',OLD.check_at,'reviewAt',OLD.next_review_at,'explicitTime',OLD.explicit_time,'notifiedAt',OLD.notified_at),json_object('text',NEW.text,'state',NEW.state,'sourceIds',json(NEW.source_ids),'threadId',NEW.thread_id,'checkAt',NEW.check_at,'reviewAt',NEW.next_review_at,'explicitTime',NEW.explicit_time,'notifiedAt',NEW.notified_at));
  END;`);
}

test("the workspace's one orchestrator from before becomes the own of the person who made its first topic", () => {
  const database = authDatabase();
  migrate(database);
  const { user_version: version } = database
    .query("PRAGMA user_version")
    .get() as { user_version: number };
  // The state before the migration of the orchestrators and the one after it: one orchestrator of the workspace,
  // made by Golem, no OAuth clients, no topic emojis, no facts, no private topics, and no recent searches.
  undoTopicsAndChats(database);
  database.run(`ALTER TABLE reminder DROP COLUMN not_before; ALTER TABLE reminder DROP COLUMN not_after; ALTER TABLE intake_check DROP COLUMN nudge_at; DROP TABLE intake_block; DROP TABLE intake_feedback; DROP TABLE intake_archive; DROP TRIGGER intake_check_created; DROP TRIGGER intake_check_changed; DROP TABLE intake_check_revision;
  ALTER TABLE routine_run DROP COLUMN input;
	DROP TABLE intake_source_read;
	DROP TABLE intake_fts;
	DROP TABLE intake_thread_read;
	DROP TABLE intake_delivery;
	DROP TABLE intake_context;
	DROP TABLE intake_check;
	DROP TABLE intake_item;
	DROP TABLE intake_source;
	ALTER TABLE credential DROP COLUMN watched;
	DROP TABLE feedback;
	DROP TABLE place_presence;
	ALTER TABLE routine DROP COLUMN place_id;
	ALTER TABLE routine DROP COLUMN place_event;
	ALTER TABLE routine DROP COLUMN place_person_id;
	DROP TABLE place;
	ALTER TABLE reminder DROP COLUMN place_id;
	ALTER TABLE reminder DROP COLUMN place_event;
	ALTER TABLE reminder DROP COLUMN triggered_at;
	DROP TABLE profile_picture;
	DROP TABLE live_activity;
	DROP TABLE suggestion;
	DROP TABLE llm_usage;
	DROP TABLE llm_usage_seen;
	DROP TABLE recent_search;
	ALTER TABLE channel DROP COLUMN owner_id;
	DROP TABLE workspace_facts;
	ALTER TABLE channel DROP COLUMN icon;
	DROP TABLE oauth_client;
	DROP INDEX thread_own_orchestrator;
	CREATE UNIQUE INDEX thread_orchestrator ON thread (workspace_id) WHERE orchestrator = 1;
	INSERT INTO channel (id, workspace_id, name, created_by, created_at) VALUES ('general', 'home', 'general', 'alice', 1), ('food', 'home', 'food', 'bob', 2);
	INSERT INTO thread (id, workspace_id, channel_id, title, created_by, created_at, updated_at, orchestrator) VALUES ('golem', 'home', 'food', 'Golem', 'golem', 1, 1, 1), ('dinner', 'home', 'food', 'Dinner', 'bob', 1, 1, 0);
	PRAGMA user_version = ${version - 30};`);
  migrate(database);
  expect(
    database
      .query("SELECT id, created_by AS createdBy FROM chat ORDER BY id")
      .all()
  ).toEqual([
    { id: "dinner", createdBy: "bob" },
    { id: "golem", createdBy: "alice" },
  ]);
  database.run(
    "INSERT INTO chat (id, workspace_id, topic_id, title, created_by, created_at, updated_at, orchestrator) VALUES ('bobs', 'home', 'general', 'Golem', 'bob', 1, 1, 1)"
  );
  expect(() =>
    database.run(
      "INSERT INTO chat (id, workspace_id, topic_id, title, created_by, created_at, updated_at, orchestrator) VALUES ('again', 'home', 'general', 'Golem', 'bob', 1, 1, 1)"
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
  undoTopicsAndChats(database);
  database.run(`ALTER TABLE reminder DROP COLUMN not_before; ALTER TABLE reminder DROP COLUMN not_after; ALTER TABLE intake_check DROP COLUMN nudge_at; DROP TABLE intake_block; DROP TABLE intake_feedback; DROP TABLE intake_archive; DROP TRIGGER intake_check_created; DROP TRIGGER intake_check_changed; DROP TABLE intake_check_revision;
  ALTER TABLE routine_run DROP COLUMN input;
	DROP TABLE intake_source_read;
	DROP TABLE intake_fts;
	DROP TABLE intake_thread_read;
	DROP TABLE intake_delivery;
	DROP TABLE intake_context;
	DROP TABLE intake_check;
	DROP TABLE intake_item;
	DROP TABLE intake_source;
	DROP TABLE feedback;
	DROP TABLE place_presence;
	ALTER TABLE routine DROP COLUMN place_id;
	ALTER TABLE routine DROP COLUMN place_event;
	ALTER TABLE routine DROP COLUMN place_person_id;
	DROP TABLE place;
	ALTER TABLE reminder DROP COLUMN place_id;
	ALTER TABLE reminder DROP COLUMN place_event;
	ALTER TABLE reminder DROP COLUMN triggered_at;
	DROP TABLE profile_picture;
	DROP TABLE live_activity;
	DROP TABLE suggestion;
	DROP TABLE llm_usage;
	DROP TABLE llm_usage_seen;
	DROP TABLE credential;
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
	PRAGMA user_version = ${version - 24};`);
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

test("notification permission expands the intake schema and leaves queued updates silent", () => {
  const database = authDatabase();
  migrate(database);
  const { user_version: version } = database
    .query("PRAGMA user_version")
    .get() as { user_version: number };
  undoTopicsAndChats(database);
  database.run(`ALTER TABLE reminder DROP COLUMN not_before; ALTER TABLE reminder DROP COLUMN not_after; ALTER TABLE intake_check DROP COLUMN nudge_at; DROP TABLE intake_block; DROP TABLE intake_feedback; DROP TABLE intake_archive; DROP TRIGGER intake_check_created; DROP TRIGGER intake_check_changed; DROP TABLE intake_check_revision;
  DROP TABLE intake_source_read;
    DROP INDEX intake_conversation;
    ALTER TABLE intake_item DROP COLUMN deleted_at;
    ALTER TABLE intake_delivery DROP COLUMN subject;
    ALTER TABLE intake_delivery DROP COLUMN notification;
    INSERT INTO intake_delivery(id,workspace_id,owner_id,thread_id,body,attention,check_ids,evidence_ids,created_at)
    VALUES('queued','home','alice','subject','Useful context','now','[]','[]',1);
    ALTER TABLE place_presence DROP COLUMN watched;
    PRAGMA user_version = ${version - 11};`);
  migrate(database);
  expect(
    database
      .query("SELECT body,notification FROM intake_delivery WHERE id='queued'")
      .get()
  ).toEqual({ body: "Useful context", notification: null });
  expect(
    database
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='intake_conversation'"
      )
      .get()
  ).toMatchObject({ name: "intake_conversation" });
});

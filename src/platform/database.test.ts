import { expect, test } from "bun:test";
import { migrate, openDatabase } from "./database.ts";

test("the workspace's one orchestrator from before becomes the own of the person who made its first channel", () => {
  const database = openDatabase(":memory:");
  migrate(database);
  const { user_version: version } = database
    .query("PRAGMA user_version")
    .get() as { user_version: number };
  // The state before the last migration: one orchestrator of the workspace, made by Golem.
  database.run(`DROP INDEX thread_own_orchestrator;
	CREATE UNIQUE INDEX thread_orchestrator ON thread (workspace_id) WHERE orchestrator = 1;
	INSERT INTO channel (id, workspace_id, name, created_by, created_at) VALUES ('general', 'home', 'general', 'alice', 1), ('food', 'home', 'food', 'bob', 2);
	INSERT INTO thread (id, workspace_id, channel_id, title, created_by, created_at, updated_at, orchestrator) VALUES ('golem', 'home', 'food', 'Golem', 'golem', 1, 1, 1), ('dinner', 'home', 'food', 'Dinner', 'bob', 1, 1, 0);
	PRAGMA user_version = ${version - 1};`);
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

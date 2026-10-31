import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/platform/database.ts";

/**
 * An in-memory database with the columns of better-auth's `organization` and `member` that the application migrations
 * read, since Golem runs better-auth's migrations first. Run `migrate` on it next.
 */
export function authDatabase(): Database {
  const database = openDatabase(":memory:");
  database.run(`CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt INTEGER NOT NULL, deletedAt INTEGER);
	CREATE TABLE member (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, userId TEXT NOT NULL);`);
  return database;
}

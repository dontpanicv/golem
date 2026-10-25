import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Artifacts } from "../artifacts/artifacts.ts";
import { Hands } from "../hands/hands.ts";
import { Integrations } from "../integrations/integrations.ts";
import { Llm, type LlmProvider } from "../llm/llm.ts";
import { type Auth, createAuth, migrateAuth } from "../platform/auth.ts";
import type { Config } from "../platform/config.ts";
import { migrate, openDatabase } from "../platform/database.ts";
import { Secrets } from "../platform/secrets.ts";
import { Routines } from "../routines/routines.ts";
import type { Embedder } from "../search/embedder.ts";
import { jpeg, readText } from "../search/extract.ts";
import { Indexer } from "../search/search.ts";
import { Threads } from "../threads/threads.ts";
import { Workspaces } from "../workspaces/workspaces.ts";

export interface App {
  readonly config: Config;
  readonly database: Database;
  readonly auth: Auth;
  readonly llm: Llm;
  readonly hands: Hands;
  readonly threads: Threads;
  readonly workspaces: Workspaces;
  readonly integrations: Integrations;
  readonly artifacts: Artifacts;
  readonly indexer: Indexer;
  readonly routines: Routines;
}

/** `embedder` gives search its meaning; without one, search and recall use keywords only. */
export async function createApp(
  config: Config,
  llmProvider: LlmProvider,
  secrets?: Secrets,
  embedder: Embedder | null = null
): Promise<App> {
  mkdirSync(config.dataDirectory, { recursive: true });
  const resolvedSecrets =
    secrets ?? (await Secrets.load(config.configDirectory));
  const database = openDatabase(join(config.dataDirectory, "golem.sqlite"));
  const auth = createAuth({
    database,
    secret: resolvedSecrets.authSecret,
    baseUrl: config.baseUrl,
    allowedEmails: config.allowedEmails,
    google: config.google,
  });
  await migrateAuth(auth);
  migrate(database);
  const llm = new Llm(database, resolvedSecrets, llmProvider);
  const workspaces = new Workspaces(database, auth);
  const integrations = new Integrations(database, resolvedSecrets, workspaces);
  const hands = new Hands(database, resolvedSecrets, workspaces, {
    baseUrl: config.baseUrl,
    binaryDirectory: resolve(import.meta.dir, "../../hands/dist"),
  });
  const artifacts = new Artifacts(database, workspaces, config);
  // The recall port and the change hook point at the indexer, which reads the threads; files read as search reads them.
  // The routine tools come from routines, which runs its work in threads.
  const threads: Threads = new Threads(
    config.dataDirectory,
    llm,
    workspaces,
    hands,
    integrations,
    artifacts,
    {
      recall: (workspaceId, query, limit) =>
        indexer.search(workspaceId, query, limit),
      changed: (workspaceId) => indexer.touch(workspaceId),
      tools: (workspaceId) => routines.tools(workspaceId),
      read: readText,
      picture: jpeg,
    }
  );
  const indexer = new Indexer(
    config.dataDirectory,
    workspaces,
    threads,
    embedder
  );
  const routines = new Routines(
    database,
    workspaces,
    integrations,
    threads,
    indexer
  );
  return {
    config,
    database,
    auth,
    llm,
    hands,
    threads,
    workspaces,
    integrations,
    artifacts,
    indexer,
    routines,
  };
}

export async function closeApp(app: App): Promise<void> {
  app.routines.close();
  await app.indexer.close();
  await app.threads.closeAll();
  await app.hands.close();
  app.database.close();
}

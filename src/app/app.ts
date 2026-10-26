import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Artifacts } from "../artifacts/artifacts.ts";
import { Browser, browserRequirements } from "../browser/browser.ts";
import { Hands, handsRequirements } from "../hands/hands.ts";
import { Integrations } from "../integrations/integrations.ts";
import { Llm, type LlmProvider } from "../llm/llm.ts";
import { apnsPush } from "../notifications/apns.ts";
import { Notifications } from "../notifications/notifications.ts";
import { type Auth, createAuth, migrateAuth } from "../platform/auth.ts";
import type { Config } from "../platform/config.ts";
import { migrate, openDatabase } from "../platform/database.ts";
import type { Requirement } from "../platform/requirements.ts";
import { Secrets } from "../platform/secrets.ts";
import { Reminders } from "../reminders/reminders.ts";
import { Routines } from "../routines/routines.ts";
import { type Embedder, embedderRequirements } from "../search/embedder.ts";
import { extractRequirements, jpeg, readText } from "../search/extract.ts";
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
  readonly notifications: Notifications;
  readonly indexer: Indexer;
  readonly routines: Routines;
  readonly reminders: Reminders;
}

const HANDS_BINARIES = resolve(import.meta.dir, "../../hands/dist");

/** Everything the modules need from this machine, checked before Golem starts. */
export async function checkRequirements(): Promise<Requirement[]> {
  const requirements = await Promise.all([
    extractRequirements(),
    embedderRequirements(),
    handsRequirements(HANDS_BINARIES),
    browserRequirements(),
  ]);
  return requirements.flat();
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
  // New connector tools reach the agents' next runs.
  const reloadTools = (workspaceId: string) => {
    threads
      .reloadTools(workspaceId)
      .catch((error: unknown) =>
        console.error("reloading the tools failed", error)
      );
  };
  const workspaces = new Workspaces(database, auth, reloadTools);
  const integrations = new Integrations(database, resolvedSecrets, workspaces, {
    directory: join(config.dataDirectory, "integrations"),
    clients: config.integrations,
    changed: reloadTools,
  });
  const hands = new Hands(database, resolvedSecrets, workspaces, {
    baseUrl: config.baseUrl,
    binaryDirectory: HANDS_BINARIES,
  });
  // The change hooks point at the indexer, which reads the threads and the artifacts.
  const artifacts = new Artifacts(database, workspaces, config, (workspaceId) =>
    indexer.touch(workspaceId)
  );
  const browser = new Browser();
  const notifications = new Notifications(
    database,
    workspaces,
    config.apns
      ? apnsPush({
          ...config.apns,
          privateKey: readFileSync(
            join(config.configDirectory, "apns.p8"),
            "utf8"
          ),
        })
      : null
  );
  // The recall port points at the indexer too; files read as search reads them.
  // The routine tools come from routines, which runs its work in threads.
  const threads: Threads = new Threads(
    config.dataDirectory,
    llm,
    workspaces,
    hands,
    integrations,
    artifacts,
    browser,
    notifications,
    {
      recall: (workspaceId, query, limit) =>
        indexer.search(workspaceId, query, limit),
      changed: (workspaceId) => indexer.touch(workspaceId),
      tools: async (workspaceId) => [
        ...(await routines.tools(workspaceId)),
        ...reminders.tools(workspaceId),
      ],
      read: readText,
      picture: jpeg,
    }
  );
  const indexer = new Indexer(
    config.dataDirectory,
    workspaces,
    threads,
    artifacts,
    embedder
  );
  const routines = new Routines(
    database,
    workspaces,
    integrations,
    threads,
    indexer
  );
  const reminders = new Reminders(database, workspaces, threads);
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
    notifications,
    indexer,
    routines,
    reminders,
  };
}

export async function closeApp(app: App): Promise<void> {
  app.reminders.close();
  app.routines.close();
  await app.indexer.close();
  await app.threads.closeAll();
  await app.integrations.close();
  await app.hands.close();
  app.database.close();
}

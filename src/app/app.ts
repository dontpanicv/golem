import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppSignIns, ProfilePictures } from "../accounts/accounts.ts";
import { Agenda } from "../agenda/agenda.ts";
import { Artifacts } from "../artifacts/artifacts.ts";
import { Browser, browserRequirements } from "../browser/browser.ts";
import { FeedbackReports } from "../feedback/feedback.ts";
import { Hands, handsRequirements } from "../hands/hands.ts";
import { Intake } from "../intake/intake.ts";
import { Integrations } from "../integrations/integrations.ts";
import { Llm, type LlmProvider } from "../llm/llm.ts";
import { apnsPush } from "../notifications/apns.ts";
import { Notifications } from "../notifications/notifications.ts";
import { Phone } from "../phone/phone.ts";
import { Places } from "../places/places.ts";
import { type Auth, createAuth, migrateAuth } from "../platform/auth.ts";
import type { Config } from "../platform/config.ts";
import { migrate, openDatabase } from "../platform/database.ts";
import { llamaRequirements } from "../platform/llama.ts";
import type { Requirement } from "../platform/requirements.ts";
import { Secrets } from "../platform/secrets.ts";
import { Reminders } from "../reminders/reminders.ts";
import { Routines } from "../routines/routines.ts";
import type { Embedder } from "../search/embedder.ts";
import { extractRequirements, jpeg, readText } from "../search/extract.ts";
import { Indexer, RecentSearches } from "../search/search.ts";
import { Threads } from "../threads/threads.ts";
import { Workspaces } from "../workspaces/workspaces.ts";

export interface App {
  readonly config: Config;
  readonly database: Database;
  readonly auth: Auth;
  readonly appSignIns: AppSignIns;
  readonly pictures: ProfilePictures;
  readonly llm: Llm;
  readonly hands: Hands;
  readonly threads: Threads;
  readonly workspaces: Workspaces;
  readonly integrations: Integrations;
  readonly artifacts: Artifacts;
  readonly notifications: Notifications;
  readonly indexer: Indexer;
  readonly recentSearches: RecentSearches;
  readonly routines: Routines;
  readonly places: Places;
  readonly reminders: Reminders;
  readonly agenda: Agenda;
  readonly intake: Intake;
  readonly phone: Phone;
  readonly feedback: FeedbackReports;
}

const HANDS_BINARIES = resolve(import.meta.dir, "../../hands/dist");

/** Everything the modules need from this machine, checked before Golem starts. */
export async function checkRequirements(): Promise<Requirement[]> {
  const requirements = await Promise.all([
    extractRequirements(),
    llamaRequirements(),
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
  const audit = Intake.audit(join(config.dataDirectory, "audit.sqlite"));
  const llm = new Llm(
    database,
    resolvedSecrets,
    llmProvider,
    config.allowedEmails[0] ?? null,
    (spend, data) =>
      audit.record(
        `model:${spend?.source ?? "background"}:${spend?.threadId ?? ""}`,
        "model.call",
        spend?.workspaceId ?? "",
        spend?.userId ?? "",
        data
      )
  );
  // New connector tools reach the agents' next runs.
  const reloadTools = (workspaceId: string) => {
    threads
      .reloadTools(workspaceId)
      .catch((error: unknown) =>
        console.error("reloading the tools failed", error)
      );
  };
  const pictures = new ProfilePictures(database);
  const workspaces = new Workspaces(database, auth, pictures, reloadTools);
  const integrations = new Integrations(database, resolvedSecrets, workspaces, {
    directory: join(config.dataDirectory, "integrations"),
    owner: config.allowedEmails[0] ?? null,
    baseUrl: config.baseUrl,
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
  const apns = config.apns
    ? apnsPush({
        ...config.apns,
        privateKey: readFileSync(
          join(config.configDirectory, "apns.p8"),
          "utf8"
        ),
      })
    : null;
  const notifications = new Notifications(
    database,
    workspaces,
    apns?.push ?? null,
    apns?.activityPush ?? null
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
      audit: (workspaceId, ownerId, trace, stage, data) =>
        audit.record(trace, stage, workspaceId, ownerId, data),
      recall: (workspaceId, query, limit, personId) =>
        indexer.search(workspaceId, query, limit, personId),
      changed: (workspaceId) => indexer.touch(workspaceId),
      observedContext: (workspaceId, threadId, ownerId, claim) =>
        intake.contextFor(workspaceId, threadId, ownerId, claim),
      answered: (workspaceId, threadId, personId) =>
        intake.finishClaims(workspaceId, threadId, personId),
      sourceRead: (thread, ownerId, read) =>
        intake.recordSourceRead(thread, ownerId, read),
      moved: (threadId, channelId) => {
        routines.moveWithThread(threadId, channelId);
        agenda.moveWithThread(threadId, channelId);
      },
      merged: (from, to) => {
        routines.moveChannel(from, to);
        agenda.moveChannel(from, to);
        intake.moveChannel(from, to);
      },
      tools: async (workspaceId) => [
        ...(await routines.tools(workspaceId)),
        ...reminders.tools(workspaceId),
        ...phone.tools(workspaceId),
        ...intake.tools(workspaceId),
        ...feedback.tools(workspaceId),
      ],
      automations: (workspaceId, personId) =>
        agenda.automations(workspaceId, personId),
      suggest: (workspaceId, threadId, channelId, suggestion) =>
        agenda.offer(workspaceId, threadId, channelId, suggestion),
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
  const places = new Places(database, workspaces);
  const routines = new Routines(
    database,
    workspaces,
    integrations,
    threads,
    indexer,
    places
  );
  const reminders = new Reminders(database, workspaces, threads, places);
  const agenda = new Agenda(
    database,
    workspaces,
    threads,
    routines,
    reminders,
    places
  );
  const intake = new Intake(
    database,
    workspaces,
    integrations,
    threads,
    indexer,
    llm,
    audit,
    notifications
  );
  const phone = new Phone(threads);
  const feedback = new FeedbackReports(
    database,
    workspaces,
    threads,
    config.allowedEmails[0] ?? null
  );
  return {
    config,
    database,
    auth,
    appSignIns: new AppSignIns(),
    pictures,
    llm,
    hands,
    threads,
    workspaces,
    integrations,
    artifacts,
    notifications,
    indexer,
    recentSearches: new RecentSearches(database),
    routines,
    places,
    reminders,
    agenda,
    intake,
    phone,
    feedback,
  };
}

export async function closeApp(app: App): Promise<void> {
  await app.intake.close();
  app.reminders.close();
  app.routines.close();
  await app.indexer.close();
  await app.threads.closeAll();
  await app.integrations.close();
  await app.hands.close();
  app.intake.audit.close();
  app.database.close();
}

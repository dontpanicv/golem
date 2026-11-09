import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppSignIns, ProfilePictures } from "../accounts/accounts.ts";
import { Agenda } from "../agenda/agenda.ts";
import { Artifacts } from "../artifacts/artifacts.ts";
import { Browser, browserRequirements } from "../browser/browser.ts";
import { Chats } from "../chats/chats.ts";
import { FeedbackReports } from "../feedback/feedback.ts";
import { Hands, handsRequirements } from "../hands/hands.ts";
import { Intake } from "../intake/intake.ts";
import { Integrations } from "../integrations/integrations.ts";
import { Llm, type LlmProvider } from "../llm/llm.ts";
import { transcribeRequirements } from "../llm/transcribe.ts";
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
import { Workspaces } from "../workspaces/workspaces.ts";

export interface App {
  readonly config: Config;
  readonly database: Database;
  readonly auth: Auth;
  readonly appSignIns: AppSignIns;
  readonly pictures: ProfilePictures;
  readonly llm: Llm;
  readonly hands: Hands;
  readonly chats: Chats;
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
    transcribeRequirements(),
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
        `model:${spend?.source ?? "background"}:${spend?.chatId ?? ""}`,
        "model.call",
        spend?.workspaceId ?? "",
        spend?.userId ?? "",
        data
      )
  );
  // New connector tools reach the agents' next runs.
  const reloadTools = (workspaceId: string) => {
    chats
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
  // The change hooks point at the indexer, which reads the chats and the artifacts.
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
  // The routine tools come from routines, which runs its work in chats.
  const chats: Chats = new Chats(
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
      observedContext: (workspaceId, chatId, ownerId, claim) =>
        intake.contextFor(workspaceId, chatId, ownerId, claim),
      answered: (workspaceId, chatId, personId) =>
        intake.finishClaims(workspaceId, chatId, personId),
      sourceRead: (chat, ownerId, read) =>
        intake.recordSourceRead(chat, ownerId, read),
      moved: (chatId, topicId) => {
        routines.moveWithChat(chatId, topicId);
        agenda.moveWithChat(chatId, topicId);
      },
      merged: (from, to) => {
        routines.moveTopic(from, to);
        agenda.moveTopic(from, to);
        intake.moveTopic(from, to);
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
      suggest: (workspaceId, chatId, topicId, suggestion) =>
        agenda.offer(workspaceId, chatId, topicId, suggestion),
      read: readText,
      picture: jpeg,
    }
  );
  const indexer = new Indexer(
    config.dataDirectory,
    workspaces,
    chats,
    artifacts,
    embedder
  );
  const places = new Places(database, workspaces);
  const routines = new Routines(
    database,
    workspaces,
    integrations,
    chats,
    indexer,
    places
  );
  const reminders = new Reminders(database, workspaces, chats, places);
  const agenda = new Agenda(
    database,
    workspaces,
    chats,
    routines,
    reminders,
    places
  );
  const intake = new Intake(
    database,
    workspaces,
    integrations,
    chats,
    indexer,
    llm,
    audit,
    notifications
  );
  const phone = new Phone(chats);
  const feedback = new FeedbackReports(
    database,
    workspaces,
    chats,
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
    chats,
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
  await app.chats.closeAll();
  await app.integrations.close();
  await app.hands.close();
  app.intake.audit.close();
  app.database.close();
}

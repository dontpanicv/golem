import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Api,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
  ModelThinkingLevel,
  Usage,
} from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  createModels,
  getSupportedThinkingLevels,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai/models";
import type { User } from "../platform/auth.ts";
import { setSetting, setting } from "../platform/database.ts";
import { HttpError } from "../platform/errors.ts";
import type { Secrets } from "../platform/secrets.ts";
import { searchWeb, type WebSearchResult } from "./search.ts";
import { llmTools } from "./tools.ts";

export interface LlmProvider {
  readonly defaultModel: string;
  /** Shown in settings, e.g. "ChatGPT". */
  readonly name: string;
  readonly provider: Provider;
  /**
   * The fast model that runs ChatGPT's web search and names new threads; without one, agents have no web_search tool
   * and a thread keeps the first line of its message as its name.
   */
  readonly fastModel?: string;
}

export interface LlmModel {
  readonly efforts: readonly ModelThinkingLevel[];
  readonly id: string;
  readonly name: string;
}

export interface LlmStatus {
  readonly connected: boolean;
  /** Whether the person is the server's owner, who alone changes the login, the model, and the effort. */
  readonly owner: boolean;
  readonly effort: ModelThinkingLevel;
  readonly error: string | null;
  readonly login: {
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresAt: number;
  } | null;
  readonly model: string;
  readonly models: readonly LlmModel[];
  readonly provider: string;
}

/** What a model call was for: a person's thread, their orchestrator, a routine run, a reminder, or work for nobody. */
export type UsageSource =
  | "thread"
  | "orchestrator"
  | "routine"
  | "reminder"
  | "background";

/** Whom a model call's cost counts for. */
export interface Spend {
  readonly workspaceId: string;
  /** The person whose turn or memory it was; null for work that acts for no person, such as a brief. */
  readonly userId: string | null;
  readonly source: UsageSource;
  readonly threadId: string | null;
}

/** The cumulative usage of one conversation by model or tool, as Pi Durable keeps it in `pi.usage`. */
export interface ConversationUsage {
  readonly models: Readonly<Record<string, Usage>>;
  readonly tools: Readonly<Record<string, Usage>>;
}

/** Tokens and cost of some model calls. `input` leaves out the tokens read from the prompt cache. */
export interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** In US dollars at the model's list price; a ChatGPT login pays its plan instead. */
  readonly cost: number;
}

/** The usage of the last days in a workspace that one person may see, newest day last. */
export interface UsageReport {
  readonly days: readonly (UsageTotals & { readonly day: string })[];
  readonly total: UsageTotals;
  readonly sources: readonly (UsageTotals & { readonly source: UsageSource })[];
  readonly models: readonly (UsageTotals & { readonly model: string })[];
  readonly threads: readonly (UsageTotals & { readonly threadId: string })[];
  /** Each person's usage, and `""` for work for nobody; only for the server's owner, else null. */
  readonly people:
    | readonly (UsageTotals & { readonly userId: string })[]
    | null;
}

const DEFAULT_EFFORT: ModelThinkingLevel = "medium";
/** The most days a usage report covers. */
const MAX_USAGE_DAYS = 366;
/** The threads that cost most, which a usage report lists. */
const TOP_THREADS = 10;
const TOTALS =
  "sum(input) AS input, sum(output) AS output, sum(cache_read) AS cacheRead, sum(cache_write) AS cacheWrite, sum(cost) AS cost";

/**
 * The one LLM provider every workspace's agents use, connected once with ChatGPT device login. Only the server's owner,
 * the first email in `allowed_emails`, changes it.
 */
export class Llm {
  readonly models: MutableModels;
  private login: {
    userCode: string;
    verificationUri: string;
    expiresAt: number;
    abort: AbortController;
  } | null = null;
  private error: string | null = null;

  constructor(
    private readonly database: Database,
    secrets: Secrets,
    readonly llmProvider: LlmProvider,
    private readonly owner: string | null
  ) {
    this.models = createModels({
      credentials: new SqliteCredentialStore(database, secrets),
    });
    this.models.setProvider(llmProvider.provider);
  }

  get providerId(): string {
    return this.llmProvider.provider.id;
  }

  model(): string {
    const chosen = setting(this.database, "llm.model");
    return chosen && this.find(chosen) ? chosen : this.llmProvider.defaultModel;
  }

  setModel(user: User, model: string): void {
    this.requireOwner(user);
    if (!this.find(model)) {
      throw new HttpError(400, `Unknown model: ${model}`);
    }
    setSetting(this.database, "llm.model", model);
  }

  /** The chosen effort, moved to the nearest level the current model supports. */
  effort(): ModelThinkingLevel {
    const chosen = (setting(this.database, "llm.effort") ??
      DEFAULT_EFFORT) as ModelThinkingLevel;
    const model = this.find(this.model());
    return model ? clampThinkingLevel(model, chosen) : chosen;
  }

  setEffort(user: User, effort: string): void {
    this.requireOwner(user);
    const model = this.find(this.model());
    if (
      !(
        model &&
        getSupportedThinkingLevels(model).includes(effort as ModelThinkingLevel)
      )
    ) {
      throw new HttpError(400, `Unknown effort: ${effort}`);
    }
    setSetting(this.database, "llm.effort", effort);
  }

  async status(user: User): Promise<LlmStatus> {
    const owner = this.isOwner(user);
    const connected =
      (await this.models.checkAuth(this.providerId).catch(() => undefined)) !==
      undefined;
    const { abort: _, ...login } = this.login ?? { abort: undefined };
    return {
      connected,
      owner,
      provider: this.llmProvider.name,
      model: this.model(),
      effort: this.effort(),
      models: this.models.getModels(this.providerId).map((model) => ({
        id: model.id,
        name: model.name,
        efforts: getSupportedThinkingLevels(model),
      })),
      login: owner && this.login ? (login as LlmStatus["login"]) : null,
      error: this.error,
    };
  }

  /** Starts a device login and returns once the code to enter is known, or the login failed. */
  async startLogin(user: User): Promise<LlmStatus> {
    this.requireOwner(user);
    if (this.login) {
      return this.status(user);
    }
    this.error = null;
    const abort = new AbortController();
    const codeShown = Promise.withResolvers<void>();
    const done = this.models
      .login(
        this.providerId,
        "oauth",
        {
          signal: abort.signal,
          // Golem has no browser on the server, so it always picks the device code method.
          prompt: async (prompt) => {
            if (
              prompt.type === "select" &&
              prompt.options.some((option) => option.id === "device_code")
            ) {
              return "device_code";
            }
            throw new Error(`Unsupported login prompt: ${prompt.message}`);
          },
          notify: (event) => {
            if (event.type !== "device_code") {
              return;
            }
            const expiresAt =
              Date.now() + (event.expiresInSeconds ?? 900) * 1000;
            this.login = {
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              expiresAt,
              abort,
            };
            codeShown.resolve();
          },
        },
        { agentName: "Golem", getDeviceId: () => this.deviceId() }
      )
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          this.error = error instanceof Error ? error.message : String(error);
        }
      })
      .finally(() => {
        if (this.login?.abort === abort) {
          this.login = null;
        }
      });
    await Promise.race([codeShown.promise, done]);
    return this.status(user);
  }

  async logout(user: User): Promise<LlmStatus> {
    this.requireOwner(user);
    this.login?.abort.abort();
    this.login = null;
    this.error = null;
    await this.models.logout(this.providerId);
    return this.status(user);
  }

  private isOwner(user: User): boolean {
    return user.email.toLowerCase() === this.owner;
  }

  private requireOwner(user: User): void {
    if (!this.isOwner(user)) {
      throw new HttpError(403, "Only the server's owner changes this");
    }
  }

  /** The agent tools of every workspace. */
  tools() {
    return this.llmProvider.fastModel ? llmTools(this) : [];
  }

  /** Searches the web with ChatGPT's own search, over the stored login. */
  async search(query: string): Promise<WebSearchResult> {
    const model = this.find(this.llmProvider.fastModel ?? "");
    const token = model && (await this.models.getAuth(model))?.auth.apiKey;
    if (!(model && token)) {
      throw new Error("Web search needs ChatGPT: connect it in Settings.");
    }
    return searchWeb({ baseUrl: model.baseUrl, model: model.id, token, query });
  }

  /**
   * The text answer of a model, by default the chosen one, at low effort, for background work such as summaries.
   * Throws on a failed call.
   */
  async complete(
    systemPrompt: string,
    text: string,
    signal?: AbortSignal,
    modelId = this.model(),
    spend?: Spend
  ): Promise<string> {
    const model = this.find(modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    const effort = clampThinkingLevel(model, "low");
    const answer = await this.models.completeSimple(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: text, timestamp: Date.now() }],
      },
      { reasoning: effort === "off" ? undefined : effort, signal }
    );
    if (spend) {
      this.record(spend, `${this.providerId}/${modelId}`, answer.usage);
    }
    if (answer.stopReason === "error" || answer.stopReason === "aborted") {
      throw new Error(answer.errorMessage ?? "The model did not answer");
    }
    return answer.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
  }

  /**
   * Counts what a conversation spent since the last call for it: `usage` is its whole usage so far, and only the
   * difference counts, so a run counts once, also after a restart.
   */
  recordConversation(
    conversationId: number,
    usage: ConversationUsage,
    spend: Spend
  ): void {
    const seenRow = this.database
      .query(
        "SELECT usage FROM llm_usage_seen WHERE workspace_id = ? AND conversation_id = ?"
      )
      .get(spend.workspaceId, conversationId) as { usage: string } | null;
    const seen = seenRow
      ? (JSON.parse(seenRow.usage) as ConversationUsage)
      : { models: {}, tools: {} };
    this.database.transaction(() => {
      for (const [bucket, prefix] of [
        ["models", ""],
        ["tools", "tool:"],
      ] as const) {
        for (const [key, now] of Object.entries(usage[bucket])) {
          const delta = minus(now, seen[bucket][key]);
          if (delta) {
            this.record(spend, `${prefix}${key}`, delta);
          }
        }
      }
      this.database
        .query(
          "INSERT INTO llm_usage_seen (workspace_id, conversation_id, usage) VALUES (?, ?, ?) ON CONFLICT (workspace_id, conversation_id) DO UPDATE SET usage = excluded.usage"
        )
        .run(spend.workspaceId, conversationId, JSON.stringify(usage));
    })();
  }

  /**
   * The usage of a workspace in its last `days` days, by day in UTC: the person's own, and for the server's owner
   * also everyone's, with each person's share.
   */
  usage(workspaceId: string, user: User, days: number): UsageReport {
    const span = Math.min(Math.max(Math.floor(days) || 30, 1), MAX_USAGE_DAYS);
    const from = new Date(Date.now() - (span - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const owner = this.isOwner(user);
    const where = `workspace_id = ? AND day >= ?${owner ? "" : " AND user_id = ?"}`;
    const values = owner ? [workspaceId, from] : [workspaceId, from, user.id];
    const query = <Row>(columns: string, groupBy: string, tail = "") =>
      (
        this.database
          .query(
            `SELECT ${columns}, ${TOTALS} FROM llm_usage WHERE ${where} GROUP BY ${groupBy} ${tail}`
          )
          .all(...values) as (Row & UsageTotals)[]
      ).map((row) => ({ ...row, ...totalsOf(row) }));
    const total = this.database
      .query(`SELECT ${TOTALS} FROM llm_usage WHERE ${where}`)
      .get(...values) as UsageTotals;
    return {
      days: query<{ day: string }>("day", "day", "ORDER BY day"),
      total: totalsOf(total),
      sources: query<{ source: UsageSource }>(
        "source",
        "source",
        "ORDER BY cost DESC, input + output DESC"
      ),
      models: query<{ model: string }>(
        "model",
        "model",
        "ORDER BY cost DESC, input + output DESC"
      ),
      threads: query<{ threadId: string }>(
        "thread_id AS threadId",
        "thread_id",
        `HAVING thread_id != '' ORDER BY cost DESC, input + output DESC LIMIT ${TOP_THREADS}`
      ),
      people: owner
        ? query<{ userId: string }>(
            "user_id AS userId",
            "user_id",
            "ORDER BY cost DESC, input + output DESC"
          )
        : null,
    };
  }

  private record(spend: Spend, model: string, usage: Usage): void {
    this.database
      .query(
        `INSERT INTO llm_usage (workspace_id, day, user_id, source, thread_id, model, input, output, cache_read, cache_write, cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, day, user_id, source, thread_id, model) DO UPDATE SET
          input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
          cache_write = cache_write + excluded.cache_write, cost = cost + excluded.cost`
      )
      .run(
        spend.workspaceId,
        new Date().toISOString().slice(0, 10),
        spend.userId ?? "",
        spend.source,
        spend.threadId ?? "",
        model,
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
        usage.cost.total
      );
  }

  private find(id: string): Model<Api> | undefined {
    return this.models.getModel(this.providerId, id);
  }

  private deviceId(): string {
    const existing = setting(this.database, "llm.deviceId");
    if (existing) {
      return existing;
    }
    const id = randomUUID();
    setSetting(this.database, "llm.deviceId", id);
    return id;
  }
}

/** `now` less `before`, or null when nothing changed. */
function minus(now: Usage, before: Usage | undefined): Usage | null {
  const delta = {
    input: now.input - (before?.input ?? 0),
    output: now.output - (before?.output ?? 0),
    cacheRead: now.cacheRead - (before?.cacheRead ?? 0),
    cacheWrite: now.cacheWrite - (before?.cacheWrite ?? 0),
    cost: now.cost.total - (before?.cost.total ?? 0),
  };
  if (Object.values(delta).every((value) => value === 0)) {
    return null;
  }
  return {
    ...delta,
    totalTokens:
      delta.input + delta.output + delta.cacheRead + delta.cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: delta.cost,
    },
  };
}

/** The totals of a row, with zeros for a sum over no rows. */
function totalsOf(row: UsageTotals): UsageTotals {
  return {
    input: row.input ?? 0,
    output: row.output ?? 0,
    cacheRead: row.cacheRead ?? 0,
    cacheWrite: row.cacheWrite ?? 0,
    cost: row.cost ?? 0,
  };
}

/** pi-ai credentials in the `provider_credential` table, encrypted. Writes run one at a time per provider. */
export class SqliteCredentialStore implements CredentialStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly database: Database,
    private readonly secrets: Secrets
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const row = this.database
      .query(
        "SELECT secret FROM provider_credential WHERE provider_id = ? AND deleted_at IS NULL"
      )
      .get(providerId) as { secret: Uint8Array } | null;
    return row
      ? (JSON.parse(this.secrets.decrypt(row.secret)) as Credential)
      : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const rows = this.database
      .query(
        "SELECT provider_id, secret FROM provider_credential WHERE deleted_at IS NULL"
      )
      .all() as {
      provider_id: string;
      secret: Uint8Array;
    }[];
    return rows.map((row) => ({
      providerId: row.provider_id,
      type: (JSON.parse(this.secrets.decrypt(row.secret)) as Credential).type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return this.serialize(providerId, async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) {
        return current;
      }
      this.database
        .query(
          "INSERT INTO provider_credential (provider_id, secret, updated_at) VALUES (?, ?, ?) ON CONFLICT (provider_id) DO UPDATE SET secret = excluded.secret, updated_at = excluded.updated_at, deleted_at = NULL"
        )
        .run(
          providerId,
          this.secrets.encrypt(JSON.stringify(next)),
          Date.now()
        );
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.serialize(providerId, async () => {
      // Nothing is removed: the login stays encrypted until the next login replaces it, and nothing reads it.
      this.database
        .query(
          "UPDATE provider_credential SET deleted_at = ? WHERE provider_id = ?"
        )
        .run(Date.now(), providerId);
    });
  }

  private serialize<T>(
    providerId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const result = (this.queues.get(providerId) ?? Promise.resolve()).then(
      operation,
      operation
    );
    this.queues.set(
      providerId,
      result.catch(() => undefined)
    );
    return result;
  }
}

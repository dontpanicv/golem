import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Api,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  createModels,
  getSupportedThinkingLevels,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai/models";
import { setSetting, setting } from "./database.ts";
import type { Secrets } from "./secrets.ts";
import { HttpError } from "./workspaces.ts";

export interface LlmProvider {
  readonly defaultModel: string;
  /** Shown in settings, e.g. "ChatGPT". */
  readonly name: string;
  readonly provider: Provider;
}

export interface LlmModel {
  readonly efforts: readonly ModelThinkingLevel[];
  readonly id: string;
  readonly name: string;
}

export interface LlmStatus {
  readonly connected: boolean;
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

const DEFAULT_EFFORT: ModelThinkingLevel = "medium";

/** The one LLM provider every workspace's agents use, connected once with ChatGPT device login. */
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
    readonly llmProvider: LlmProvider
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

  setModel(model: string): void {
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

  setEffort(effort: string): void {
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

  async status(): Promise<LlmStatus> {
    const connected =
      (await this.models.checkAuth(this.providerId).catch(() => undefined)) !==
      undefined;
    const { abort: _, ...login } = this.login ?? { abort: undefined };
    return {
      connected,
      provider: this.llmProvider.name,
      model: this.model(),
      effort: this.effort(),
      models: this.models.getModels(this.providerId).map((model) => ({
        id: model.id,
        name: model.name,
        efforts: getSupportedThinkingLevels(model),
      })),
      login: this.login ? (login as LlmStatus["login"]) : null,
      error: this.error,
    };
  }

  /** Starts a device login and returns once the code to enter is known, or the login failed. */
  async startLogin(): Promise<LlmStatus> {
    if (this.login) {
      return this.status();
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
    return this.status();
  }

  async logout(): Promise<LlmStatus> {
    this.login?.abort.abort();
    this.login = null;
    this.error = null;
    await this.models.logout(this.providerId);
    return this.status();
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

/** pi-ai credentials in the `provider_credential` table, encrypted. Writes run one at a time per provider. */
export class SqliteCredentialStore implements CredentialStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly database: Database,
    private readonly secrets: Secrets
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const row = this.database
      .query("SELECT secret FROM provider_credential WHERE provider_id = ?")
      .get(providerId) as { secret: Uint8Array } | null;
    return row
      ? (JSON.parse(this.secrets.decrypt(row.secret)) as Credential)
      : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const rows = this.database
      .query("SELECT provider_id, secret FROM provider_credential")
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
          "INSERT INTO provider_credential (provider_id, secret, updated_at) VALUES (?, ?, ?) ON CONFLICT (provider_id) DO UPDATE SET secret = excluded.secret, updated_at = excluded.updated_at"
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
      this.database
        .query("DELETE FROM provider_credential WHERE provider_id = ?")
        .run(providerId);
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

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthPrompt,
  Credential,
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { until } from "../../test/harness.ts";
import type { NotificationInput } from "../notifications/notifications.ts";
import {
  migrate,
  openDatabase,
  setSetting,
  setting,
} from "../platform/database.ts";
import { HttpError } from "../platform/errors.ts";
import { Secrets } from "../platform/secrets.ts";
import { Threads } from "../threads/threads.ts";
import { Llm, SqliteCredentialStore } from "./llm.ts";

/** The server's owner, who alone changes the login, the model, and the effort. */
const OWNER = { id: "owner", name: "Owner", email: "owner@example.com" };

function database() {
  const opened = openDatabase(":memory:");
  migrate(opened);
  return opened;
}

/** A faux provider with one plain model and one reasoning model. */
function twoModels() {
  return fauxProvider({
    models: [
      { id: "fast", name: "Fast" },
      { id: "deep", name: "Deep", reasoning: true },
    ],
  });
}

type LoginScript = (
  interaction: ProviderAuthInteraction,
  options?: { getDeviceId?: () => string; agentName?: string }
) => Promise<OAuthCredential>;

/** An Llm whose provider signs in only with OAuth, and the OAuth login runs `script`. */
function oauthLlm(script: LoginScript) {
  const faux = twoModels();
  const secrets = Secrets.forTests();
  const db = database();
  let logins = 0;
  const provider = {
    ...faux.provider,
    name: "Faux",
    auth: {
      oauth: {
        name: "Faux account",
        login: (
          interaction: ProviderAuthInteraction,
          options?: { getDeviceId?: () => string; agentName?: string }
        ) => {
          logins += 1;
          return script(interaction, options);
        },
        refresh: async (credential: OAuthCredential) => credential,
        toAuth: async (credential: OAuthCredential) => ({
          apiKey: credential.access,
        }),
      },
    },
  };
  const llm = new Llm(
    db,
    secrets,
    {
      provider,
      name: "ChatGPT",
      defaultModel: "fast",
    },
    OWNER.email
  );
  return { llm, db, secrets, logins: () => logins };
}

const deviceCode = {
  type: "device_code",
  userCode: "ABCD-1234",
  verificationUri: "https://auth.example/device",
} as const;

function oauthCredential(access: string): OAuthCredential {
  return {
    type: "oauth",
    access,
    refresh: "refresh-token",
    expires: Date.now() + 3_600_000,
  };
}

describe("Llm settings", () => {
  test("the model is the default until someone picks a model the provider offers", () => {
    const db = database();
    const llm = new Llm(
      db,
      Secrets.forTests(),
      {
        provider: twoModels().provider,
        name: "Test",
        defaultModel: "fast",
      },
      OWNER.email
    );
    expect(llm.model()).toBe("fast");
    expect(() => llm.setModel(OWNER, "gone")).toThrow(
      new HttpError(400, "Unknown model: gone")
    );
    llm.setModel(OWNER, "deep");
    expect(llm.model()).toBe("deep");
    expect(setting(db, "llm.model")).toBe("deep");
    // A model that the provider stopped offering falls back to the default.
    setSetting(db, "llm.model", "retired");
    expect(llm.model()).toBe("fast");
  });

  test("the effort moves to the nearest level the current model supports", () => {
    const llm = new Llm(
      database(),
      Secrets.forTests(),
      {
        provider: twoModels().provider,
        name: "Test",
        defaultModel: "fast",
      },
      OWNER.email
    );
    expect(llm.effort()).toBe("off");
    expect(() => llm.setEffort(OWNER, "high")).toThrow("Unknown effort: high");
    llm.setModel(OWNER, "deep");
    expect(llm.effort()).toBe("medium");
    expect(() => llm.setEffort(OWNER, "extreme")).toThrow(
      "Unknown effort: extreme"
    );
    llm.setEffort(OWNER, "high");
    expect(llm.effort()).toBe("high");
    llm.setModel(OWNER, "fast");
    expect(llm.effort()).toBe("off");
    // The choice stays for when a model that supports it comes back.
    llm.setModel(OWNER, "deep");
    expect(llm.effort()).toBe("high");
  });

  test("the status lists every model with the efforts it supports", async () => {
    const llm = new Llm(
      database(),
      Secrets.forTests(),
      {
        provider: twoModels().provider,
        name: "Test",
        defaultModel: "fast",
      },
      OWNER.email
    );
    const status = await llm.status(OWNER);
    expect(status.provider).toBe("Test");
    expect(status.models.map((model) => [model.id, model.name])).toEqual([
      ["fast", "Fast"],
      ["deep", "Deep"],
    ]);
    expect(status.models[0]!.efforts).toEqual(["off"]);
    expect(status.models[1]!.efforts).toContain("high");
  });
});

describe("Llm device login", () => {
  test("shows the device code, then stores the credential encrypted when the login completes", async () => {
    const approved = Promise.withResolvers<void>();
    const seen: { method: string; deviceIds: string[]; agentName?: string } = {
      method: "",
      deviceIds: [],
    };
    const { llm, db, secrets, logins } = oauthLlm(
      async (interaction, options) => {
        seen.method = await interaction.prompt({
          type: "select",
          message: "How do you want to sign in?",
          options: [
            { id: "browser", label: "Browser" },
            { id: "device_code", label: "Device code" },
          ],
        });
        seen.deviceIds.push(options!.getDeviceId!(), options!.getDeviceId!());
        seen.agentName = options?.agentName;
        interaction.notify({ type: "progress", message: "Starting" });
        interaction.notify(deviceCode);
        await approved.promise;
        return oauthCredential("access-token");
      }
    );

    expect(await llm.status(OWNER)).toMatchObject({
      connected: false,
      login: null,
      owner: true,
    });
    const someone = { id: "someone", name: "Someone", email: "a@example.com" };
    await expect(llm.startLogin(someone)).rejects.toThrow(
      new HttpError(403, "Only the server's owner changes this")
    );
    const before = Date.now();
    const started = await llm.startLogin(OWNER);
    // Only the owner sees the device code.
    expect(await llm.status(someone)).toMatchObject({
      owner: false,
      login: null,
    });
    expect(seen.method).toBe("device_code");
    expect(seen.agentName).toBe("Golem");
    // The device ID is made once and then kept.
    expect(seen.deviceIds[0]).toBe(seen.deviceIds[1]!);
    expect(setting(db, "llm.deviceId")).toBe(seen.deviceIds[0]!);
    expect(started.connected).toBe(false);
    expect(started.login).toMatchObject({
      userCode: "ABCD-1234",
      verificationUri: "https://auth.example/device",
    });
    // Without an expiry from the provider, the code is good for 15 minutes.
    expect(started.login!.expiresAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(started.login!.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
    expect(started.login).not.toHaveProperty("abort");

    // A second start while the code shows does not start another login.
    expect((await llm.startLogin(OWNER)).login?.userCode).toBe("ABCD-1234");
    expect(logins()).toBe(1);

    approved.resolve();
    const connected = await until(
      () => llm.status(OWNER),
      (status) => status.connected
    );
    expect(connected).toMatchObject({ login: null, error: null });
    const row = db
      .query("SELECT secret FROM provider_credential WHERE provider_id = ?")
      .get(llm.providerId) as { secret: Uint8Array };
    expect(Buffer.from(row.secret).toString("utf8")).not.toContain(
      "access-token"
    );
    expect(JSON.parse(secrets.decrypt(row.secret))).toMatchObject({
      type: "oauth",
      access: "access-token",
    });

    expect(await llm.logout(OWNER)).toMatchObject({
      connected: false,
      login: null,
    });
    // The login stays, encrypted and marked deleted; nothing reads it again.
    expect(
      db
        .query(
          "SELECT COUNT(*) AS count FROM provider_credential WHERE deleted_at IS NOT NULL"
        )
        .get()
    ).toEqual({ count: 1 });
    expect((await llm.status(OWNER)).connected).toBe(false);
  });

  test("uses the expiry the provider gives for the device code", async () => {
    const { llm } = oauthLlm(async (interaction) => {
      interaction.notify({ ...deviceCode, expiresInSeconds: 60 });
      return await new Promise<OAuthCredential>(() => undefined);
    });
    const before = Date.now();
    const { login } = await llm.startLogin(OWNER);
    expect(login!.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(login!.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    await llm.logout(OWNER);
  });

  test("a prompt other than the device code choice fails the login", async () => {
    const { llm } = oauthLlm(async (interaction) => {
      await interaction.prompt({
        type: "manual_code",
        message: "Paste the code",
      } as AuthPrompt);
      return oauthCredential("never");
    });
    expect(await llm.startLogin(OWNER)).toMatchObject({
      connected: false,
      login: null,
      error: "Unsupported login prompt: Paste the code",
    });
  });

  test("a select prompt without the device code option fails the login", async () => {
    const { llm } = oauthLlm(async (interaction) => {
      await interaction.prompt({
        type: "select",
        message: "Pick a browser",
        options: [{ id: "browser", label: "Browser" }],
      });
      return oauthCredential("never");
    });
    expect((await llm.startLogin(OWNER)).error).toBe(
      "Unsupported login prompt: Pick a browser"
    );
  });

  test("a login that fails after the code shows reports the error, and a new start clears it", async () => {
    let attempt = 0;
    const rejected = Promise.withResolvers<void>();
    const { llm } = oauthLlm(async (interaction) => {
      attempt += 1;
      if (attempt === 2) {
        // biome-ignore lint/style/useThrowOnlyError: a provider can throw a value that is not an Error.
        throw "provider is down";
      }
      interaction.notify(deviceCode);
      await rejected.promise;
      throw new Error("The device code expired");
    });
    expect((await llm.startLogin(OWNER)).login?.userCode).toBe("ABCD-1234");
    rejected.resolve();
    expect(
      await until(
        () => llm.status(OWNER),
        (status) => status.error !== null
      )
    ).toMatchObject({ login: null, error: "The device code expired" });
    // An error that is not an Error object shows as text.
    expect((await llm.startLogin(OWNER)).error).toBe("provider is down");
  });

  test("logout cancels a login in progress without an error", async () => {
    const { llm } = oauthLlm(async (interaction) => {
      interaction.notify(deviceCode);
      return await new Promise<OAuthCredential>(() => undefined);
    });
    expect((await llm.startLogin(OWNER)).login).not.toBeNull();
    expect(await llm.logout(OWNER)).toMatchObject({
      connected: false,
      login: null,
      error: null,
    });
    await Bun.sleep(0);
    expect((await llm.status(OWNER)).error).toBeNull();
  });
});

describe("SqliteCredentialStore", () => {
  const apiKey = (key: string): Credential => ({ type: "api_key", key });

  test("reads, writes, lists, and deletes encrypted credentials per provider", async () => {
    const db = database();
    const secrets = Secrets.forTests();
    const store = new SqliteCredentialStore(db, secrets);
    expect(await store.read("openai")).toBeUndefined();
    expect(await store.list()).toEqual([]);

    expect(await store.modify("openai", async () => apiKey("sk-1"))).toEqual(
      apiKey("sk-1")
    );
    await store.modify("codex", async () => oauthCredential("token"));
    expect(await store.read("openai")).toEqual(apiKey("sk-1"));
    expect(await store.list()).toEqual([
      { providerId: "openai", type: "api_key" },
      { providerId: "codex", type: "oauth" },
    ]);
    const stored = db
      .query("SELECT secret FROM provider_credential WHERE provider_id = ?")
      .get("openai") as { secret: Uint8Array };
    expect(Buffer.from(stored.secret).toString("utf8")).not.toContain("sk-1");

    // `modify` sees the current credential and replaces it.
    expect(
      await store.modify("openai", async (current) =>
        apiKey(`${(current as { key: string }).key}-rotated`)
      )
    ).toEqual(apiKey("sk-1-rotated"));
    // Returning nothing keeps the current credential.
    expect(await store.modify("openai", async () => undefined)).toEqual(
      apiKey("sk-1-rotated")
    );
    expect(await store.read("openai")).toEqual(apiKey("sk-1-rotated"));

    await store.delete("openai");
    expect(await store.read("openai")).toBeUndefined();
    expect(await store.list()).toEqual([
      { providerId: "codex", type: "oauth" },
    ]);
    // A new login replaces the deleted one.
    await store.modify("openai", async () => apiKey("sk-2"));
    expect(await store.read("openai")).toEqual(apiKey("sk-2"));
  });

  test("writes to one provider run one at a time, and a failed write does not stop the next", async () => {
    const store = new SqliteCredentialStore(database(), Secrets.forTests());
    const increment = (current: Credential | undefined) =>
      Bun.sleep(1).then(() =>
        apiKey(String(Number((current as { key?: string })?.key ?? 0) + 1))
      );
    const failed = store.modify("openai", async () => {
      await Bun.sleep(1);
      throw new Error("disk full");
    });
    const writes = Array.from({ length: 5 }, () =>
      store.modify("openai", increment)
    );
    await expect(failed).rejects.toThrow("disk full");
    expect(await Promise.all(writes)).toEqual(
      ["1", "2", "3", "4", "5"].map(apiKey)
    );
    // A delete waits for the writes queued before it.
    const last = store.modify("openai", increment);
    const deleted = store.delete("openai");
    expect(await last).toEqual(apiKey("6"));
    await deleted;
    expect(await store.read("openai")).toBeUndefined();
  });
});

const hooks = {
  changed: () => undefined,
  recall: async () => ({ results: [] }),
  read: async () => null,
  picture: async () => null,
  tools: async () => [],
};
const noMachines = {
  destructive: async () => null,
  file: () => Promise.reject(new Error("No machines are paired.")),
  put: () => Promise.reject(new Error("No machines are paired.")),
  machineNamed: () => {
    throw new Error("No machines are paired.");
  },
  tools: () => [],
  section: () => ({ key: "machines", render: () => undefined }),
};
const noIntegrations = { tools: async () => [], namespaces: () => [] };
const noArtifacts = {
  content: () => "",
  inWorkspace: () => [],
  tools: () => [],
};
const noNotifications = {
  notify: (input: NotificationInput) => ({
    ...input,
    id: "notification",
    createdAt: 0,
    readAt: null,
  }),
};
const noBrowser = {
  pdf: () => Promise.reject(new Error("There is no browser.")),
  download: () => Promise.reject(new Error("There is no browser.")),
  screenshot: async () => null,
  tools: () => [],
};

/** Threads over a registry in memory, with the registry methods that creating and sending use. */
function threadsOver(dataDirectory: string, llm: Llm) {
  const registered = new Map<
    string,
    {
      id: string;
      workspaceId: string;
      conversationId: number;
      channelId: string;
      ownerId: null;
    }
  >();
  const registry = {
    requireMember: (workspaceId: string) => ({
      id: workspaceId,
      name: "Family",
      role: "owner",
    }),
    registerThread: (
      workspaceId: string,
      thread: {
        id: string;
        channelId: string;
        title: string;
        conversationId: number;
      }
    ) => {
      registered.set(thread.id, { ...thread, workspaceId, ownerId: null });
      return { ...thread, updatedAt: 0, settledAt: null };
    },
    thread: (threadId: string) => ({
      ...registered.get(threadId)!,
      title: "",
      updatedAt: 0,
      settledAt: null,
    }),
    threadsIn: () =>
      [...registered.values()].map((thread) => ({
        ...thread,
        title: "",
        updatedAt: 0,
        settledAt: null,
      })),
    channel: (_workspaceId: string, channelId: string) => ({
      id: channelId,
      name: channelId,
      summary: null,
      threads: [],
    }),
    channelsIn: () => [],
    orchestratorOf: () => null,
    addChannel: () => {
      throw new Error("No channels here");
    },
    removeChannel: () => {
      throw new Error("No channels here");
    },
    setChannelSummary: () => undefined,
    touchThread: () => undefined,
    agentMember: () => ({ id: "user-1", name: "Alice", email: "" }),
    members: () => [],
  };
  const threads = new Threads(
    dataDirectory,
    llm,
    registry,
    noMachines,
    noIntegrations,
    noArtifacts,
    noBrowser,
    noNotifications,
    hooks
  );
  return { threads, registry, thread: (id: string) => registry.thread(id) };
}

describe("Threads with the Llm", () => {
  const user = { id: "user-1", name: "Alice", email: "alice@example.com" };

  test("a thread follows the model chosen in settings, also after it changes", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "golem-llm-"));
    const faux = twoModels();
    const llm = new Llm(
      database(),
      Secrets.forTests(),
      {
        provider: faux.provider,
        name: "Test",
        defaultModel: "fast",
      },
      OWNER.email
    );
    const { threads, thread } = threadsOver(dataDirectory, llm);
    const used: string[] = [];
    const answer =
      (text: string) =>
      (
        _context: unknown,
        _options: unknown,
        _state: unknown,
        model: { id: string }
      ) => {
        used.push(model.id);
        return fauxAssistantMessage(text);
      };
    faux.setResponses([answer("First"), answer("Second")]);
    try {
      const { id } = await threads.create(
        "workspace-1",
        user,
        "general",
        "Hello"
      );
      const answered = (count: number) =>
        until(
          () => threads.messages(thread(id)),
          (current) => current.messages.length === count && !current.running
        );
      await answered(2);
      llm.setModel(OWNER, "deep");
      await threads.send(id, user, "Think harder");
      const state = await answered(4);
      expect(used).toEqual(["fast", "deep"]);
      expect(state.messages.map((message) => message.text)).toEqual([
        "Hello",
        "First",
        "Think harder",
        "Second",
      ]);
    } finally {
      await threads.closeAll();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  test("the threads of a workspace are separate conversations in one session file, also after a restart", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "golem-llm-"));
    const faux = twoModels();
    const llm = new Llm(
      database(),
      Secrets.forTests(),
      {
        provider: faux.provider,
        name: "Test",
        defaultModel: "fast",
      },
      OWNER.email
    );
    faux.setResponses([
      fauxAssistantMessage("Pasta"),
      fauxAssistantMessage("Saturday"),
      fauxAssistantMessage("Sunday"),
    ]);
    const first = threadsOver(dataDirectory, llm);
    const texts = async (threads: Threads, id: string, count: number) =>
      (
        await until(
          () => threads.messages(first.thread(id)),
          (state) => state.messages.length === count && !state.running
        )
      ).messages.map((message) => message.text);
    try {
      const dinner = await first.threads.create(
        "family",
        user,
        "food",
        "Dinner?"
      );
      expect(await texts(first.threads, dinner.id, 2)).toEqual([
        "Dinner?",
        "Pasta",
      ]);
      const trip = await first.threads.create(
        "family",
        user,
        "travel",
        "When do we go?"
      );
      expect(await texts(first.threads, trip.id, 2)).toEqual([
        "When do we go?",
        "Saturday",
      ]);
      const workspace = join(dataDirectory, "workspaces", "family");
      expect(await Bun.file(join(workspace, "session.sqlite")).exists()).toBe(
        true
      );
      expect(
        await Bun.file(
          join(workspace, "threads", dinner.id, "session.sqlite")
        ).exists()
      ).toBe(false);
      const before = await first.threads.version(first.thread(trip.id));
      await first.threads.closeAll();

      // A new process opens the same file and finds each thread's own transcript.
      const reopened = new Threads(
        dataDirectory,
        llm,
        first.registry,
        noMachines,
        noIntegrations,
        noArtifacts,
        noBrowser,
        noNotifications,
        hooks
      );
      try {
        expect(await texts(reopened, dinner.id, 2)).toEqual([
          "Dinner?",
          "Pasta",
        ]);
        expect(await texts(reopened, trip.id, 2)).toEqual([
          "When do we go?",
          "Saturday",
        ]);
        expect(await reopened.version(first.thread(trip.id))).toBe(before);
        await reopened.send(trip.id, user, "Or later?");
        expect(await texts(reopened, trip.id, 4)).toEqual([
          "When do we go?",
          "Saturday",
          "Or later?",
          "Sunday",
        ]);
        expect(await reopened.version(first.thread(trip.id))).not.toBe(before);
      } finally {
        await reopened.closeAll();
      }
    } finally {
      await first.threads.closeAll();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});

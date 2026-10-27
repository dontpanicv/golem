import { mkdirSync } from "node:fs";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import type { Connector, ConnectorTool, Device } from "./integrations.ts";

/** How long a read of the store may take. */
const READ_MS = 30 * 1000;
/** How long Golem waits before it starts a stopped sync again. */
const RESTART_MS = 60 * 1000;
/** The most messages that wacli asks the phone for at a time. */
const BACKFILL_BATCH = 500;
const LIMIT = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: 200,
    description: "At most; 50 when not given.",
  })
);

/**
 * WhatsApp through wacli (https://github.com/openclaw/wacli), which links a store as a device of the person's own
 * number, as WhatsApp Web does, and keeps their chats in it. It is not WhatsApp's own API, and WhatsApp can ban a number
 * that uses it. Agents read the store; they only draft messages, as wa.me links that the person sends.
 */
export function whatsAppConnector(binary: string): Connector {
  const whatsApp = new WhatsApp(binary);
  return {
    id: "whatsapp",
    name: "WhatsApp",
    description:
      "The person's own WhatsApp chats, from when they linked it: chats, messages, search, and contacts. Draft a message as a wa.me link; the person sends it.",
    secretLabel: null,
    device: whatsApp,
    tools: [
      readTool(whatsApp, {
        name: "whatsapp_chats",
        description:
          "The chats, pinned first, then newest. `jid` identifies a chat for the other tools.",
        parameters: Type.Object({
          query: Type.Optional(
            Type.String({ description: "A part of the chat's name or JID." })
          ),
          unread: Type.Optional(
            Type.Boolean({
              description: "Only the chats with unread messages.",
            })
          ),
          limit: LIMIT,
        }),
        command: ({ query, unread, limit }) => [
          "chats",
          "list",
          ...option("--query", query),
          ...(unread ? ["--unread"] : []),
          ...option("--limit", limit),
        ],
      }),
      readTool(whatsApp, {
        name: "whatsapp_messages",
        description:
          "The messages of a chat, or of all chats, newest first. Pass `cursor` from `page.next_cursor` for the next page.",
        parameters: Type.Object({
          chat: Type.Optional(Type.String({ description: "The chat's JID." })),
          after: Type.Optional(
            Type.String({ description: "A date, such as 2026-10-01." })
          ),
          before: Type.Optional(Type.String({ description: "A date." })),
          cursor: Type.Optional(Type.String()),
          limit: LIMIT,
        }),
        command: ({ chat, after, before, cursor, limit }) => [
          "messages",
          "list",
          ...option("--chat", chat),
          ...option("--after", after),
          ...option("--before", before),
          ...option("--cursor", cursor),
          ...option("--limit", limit),
        ],
      }),
      readTool(whatsApp, {
        name: "whatsapp_search",
        description: "Messages that contain words, best match first.",
        parameters: Type.Object({
          query: Type.String(),
          chat: Type.Optional(Type.String({ description: "The chat's JID." })),
          cursor: Type.Optional(Type.String()),
          limit: LIMIT,
        }),
        command: ({ query, chat, cursor, limit }) => [
          "messages",
          "search",
          query,
          ...option("--chat", chat),
          ...option("--cursor", cursor),
          ...option("--limit", limit),
        ],
      }),
      {
        name: "whatsapp_backfill",
        description:
          "Asks the person's phone for messages of a chat older than the oldest that Golem has, and keeps them; then read them with the other tools. The phone must be online. It takes up to two minutes for every 500 messages.",
        parameters: Type.Object({
          chat: Type.String({ description: "The chat's JID." }),
          messages: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 5000,
              description: "How many older messages; 500 when not given.",
            })
          ),
        }),
        execute: ({ chat, messages = BACKFILL_BATCH }, store, signal) =>
          whatsApp.backfill(store, chat, messages, signal),
      },
      readTool(whatsApp, {
        name: "whatsapp_contacts",
        description: "Contacts whose name or phone number matches.",
        parameters: Type.Object({ query: Type.String(), limit: LIMIT }),
        command: ({ query, limit }) => [
          "contacts",
          "search",
          query,
          ...option("--limit", limit),
        ],
      }),
      {
        name: "whatsapp_draft",
        description:
          "A draft message to a person, as a wa.me link that opens WhatsApp with the text; give the link to the person, who sends it.",
        parameters: Type.Object({
          phone: Type.String({
            description: "The recipient's number with its country code.",
          }),
          text: Type.String(),
        }),
        execute: async ({ phone, text }) => ({
          link: draftLink(phone, text),
        }),
      },
    ],
  };
}

/** A wa.me link that opens a chat with `phone` and the text filled in. */
export function draftLink(phone: string, text: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) {
    throw new Error("Give the number with its country code");
  }
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Runs wacli for the stores of linked numbers: links them, keeps them current, and reads them. */
export class WhatsApp implements Device {
  /** The process that keeps each store current. */
  private readonly syncs = new Map<
    string,
    Bun.Subprocess<"ignore", "ignore", "pipe">
  >();
  private readonly restarts = new Map<string, Timer>();
  /** The last backfill of each store. */
  private readonly backfills = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(private readonly binary: string) {}

  /** Asks WhatsApp for the code that links the store to `phone`; that process then keeps the store current. */
  link(
    store: string,
    phone: string
  ): Promise<{ code: string; linked: Promise<void> }> {
    mkdirSync(store, { recursive: true });
    return new Promise((resolve, reject) => {
      let linked!: () => void;
      let failed!: (error: Error) => void;
      const linking = new Promise<void>((resolveLinked, rejectLinked) => {
        linked = resolveLinked;
        failed = rejectLinked;
      });
      // A store that never links has no use for the rejection.
      linking.catch(() => undefined);
      let connected = false;
      const noCode = setTimeout(() => {
        this.stop(store);
        reject(new Error("WhatsApp gave no code"));
      }, READ_MS);
      this.sync(store, ["auth", "--phone", phone, "--follow"], (event) => {
        if (event.event === "pair_code") {
          clearTimeout(noCode);
          resolve({ code: String(event.data?.code), linked: linking });
        }
        if (event.event === "connected") {
          connected = true;
          linked();
        }
      }).exited.then((code) => {
        clearTimeout(noCode);
        if (connected) {
          return;
        }
        // A store that did not link has nothing to sync.
        this.stop(store);
        const error = new Error(
          `WhatsApp did not link (wacli exited with ${code})`
        );
        reject(error);
        failed(error);
      });
    });
  }

  keep(store: string): void {
    this.sync(store, ["sync", "--follow"]);
  }

  /** Stops keeping the store current, and removes its device from the number. */
  async unlink(store: string): Promise<void> {
    this.stop(store);
    const process = Bun.spawn(
      [this.binary, "--store", store, "auth", "logout"],
      {
        stdout: "ignore",
        stderr: "pipe",
      }
    );
    if ((await process.exited) !== 0) {
      console.error(
        "unlinking WhatsApp failed",
        await new Response(process.stderr).text()
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const stores = [...this.syncs.keys(), ...this.restarts.keys()];
    for (const store of stores) {
      this.stop(store);
    }
    await Promise.allSettled(
      stores.map((store) => this.syncs.get(store)?.exited)
    );
  }

  /** Runs wacli on the store without changing it, and returns the `data` of its answer. */
  read(
    store: string,
    command: readonly string[],
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    return this.run(store, ["--read-only", ...command], READ_MS, signal);
  }

  /**
   * Asks the phone for `messages` messages of `chat` older than the store's oldest. The sync holds the store's lock,
   * so it stops until wacli is done; backfills of one store wait for each other.
   */
  backfill(
    store: string,
    chat: string,
    messages: number,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    const requests = Math.ceil(messages / BACKFILL_BATCH);
    // wacli waits up to a minute for each answer of the phone, and asks again once.
    const minutes = requests * 2 + 1;
    const backfill = (this.backfills.get(store) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const syncing = this.syncs.get(store);
        this.stop(store);
        await syncing?.exited;
        try {
          return await this.run(
            store,
            [
              "--timeout",
              `${minutes}m`,
              "history",
              "backfill",
              "--chat",
              chat,
              "--count",
              String(Math.min(messages, BACKFILL_BATCH)),
              "--requests",
              String(requests),
            ],
            minutes * 60 * 1000,
            signal
          );
        } finally {
          // shortcut: a backfill that runs while Golem closes outlives it and holds the lock until wacli's timeout;
          // the next Golem's sync retries every minute until then.
          if (!this.closed) {
            this.keep(store);
          }
        }
      });
    this.backfills.set(store, backfill);
    return backfill;
  }

  /** Runs a wacli command on the store, and returns the `data` of its answer. */
  private async run(
    store: string,
    command: readonly string[],
    timeout: number,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    const process = Bun.spawn(
      [this.binary, "--store", store, "--json", ...command],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout,
        ...(signal ? { signal } : {}),
      }
    );
    const [output, errors] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    let answer: { success?: boolean; data?: unknown; error?: string | null };
    try {
      answer = JSON.parse(output);
    } catch (error) {
      throw new Error(errors.trim() || "WhatsApp gave no answer", {
        cause: error,
      });
    }
    if (!answer.success) {
      throw new Error(answer.error || "WhatsApp failed");
    }
    return answer.data;
  }

  /**
   * Keeps a wacli process that syncs the store running, `command` first, then `sync --follow` once it stops; WhatsApp
   * logging the device out stops it for good.
   */
  private sync(
    store: string,
    command: readonly string[],
    onEvent?: (event: WacliEvent) => void
  ) {
    this.stop(store);
    const process = Bun.spawn(
      [this.binary, "--store", store, "--events", ...command],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" }
    );
    this.syncs.set(store, process);
    let loggedOut = false;
    readEvents(process.stderr, (event) => {
      if (event.event === "logged_out") {
        loggedOut = true;
        console.error("WhatsApp logged out the device of", store);
      }
      onEvent?.(event);
    });
    process.exited.then(() => {
      if (this.syncs.get(store) !== process || loggedOut) {
        return;
      }
      this.syncs.delete(store);
      this.restarts.set(
        store,
        setTimeout(() => this.keep(store), RESTART_MS)
      );
    });
    return process;
  }

  private stop(store: string): void {
    clearTimeout(this.restarts.get(store));
    this.restarts.delete(store);
    const process = this.syncs.get(store);
    this.syncs.delete(store);
    process?.kill();
  }
}

interface WacliEvent {
  readonly event: string;
  readonly data?: Record<string, unknown>;
}

/** Calls `onEvent` with each NDJSON event that wacli writes; it writes other lines too. */
async function readEvents(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: WacliEvent) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines) {
      try {
        onEvent(JSON.parse(line));
      } catch {
        // Not an event.
      }
    }
  }
}

/** A tool that reads the person's linked store with a wacli command. */
function readTool<Parameters extends TSchema>(
  whatsApp: WhatsApp,
  tool: {
    name: string;
    description: string;
    parameters: Parameters;
    command: (args: Static<Parameters>) => string[];
  }
): ConnectorTool<Parameters> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: (args, store, signal) =>
      whatsApp.read(store, tool.command(args), signal),
  };
}

function option(flag: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [flag, String(value)];
}

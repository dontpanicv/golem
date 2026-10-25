import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
  type AgentState,
  type Conversation,
  type ConversationId,
  type ConversationView,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { randomUUIDv5 } from "bun";
import type { Llm } from "../llm/llm.ts";
import type { User } from "../platform/auth.ts";
import { notFound, required } from "../platform/errors.ts";
import type {
  ThreadRef,
  ThreadSummary,
  Workspaces,
} from "../workspaces/workspaces.ts";

export interface Message {
  readonly agent: boolean;
  readonly author: string;
  readonly authorId: string | null;
  readonly failed: boolean;
  readonly id: string;
  readonly streaming: boolean;
  readonly text: string;
  readonly time: number;
}

export interface ThreadMessages {
  readonly messages: readonly Message[];
  readonly running: boolean;
}

const AUTHORED = "golem.message";
/** A message the agent of another thread sent to this one. */
const RELAYED = "golem.relay";
/** How often one person's message may pass between threads: a question to another thread, and its answer back. */
const MAX_HOPS = 2;
const INSTRUCTIONS =
  "You are Golem, a family assistant. Several family members can write in one thread; each message starts with its author's name. Answer concisely. Use the recall tool to look up anything said or stored earlier in this workspace before saying you do not know. The workspace has channels, and each channel has threads. You can list them, read a thread, start a thread in any channel, and send a message to another thread. The agent of that thread answers there, and can send its answer back with send_to_thread. Whenever you mention a thread, write it as the link the tools give, exactly: [title](thread:<id>). People see it as a link that opens the thread. Never write a thread id on its own.";

interface Relay extends JsonObject {
  readonly fromThreadId: string;
  readonly fromTitle: string;
  readonly hops: number;
  readonly text: string;
}

export interface ThreadHooks {
  /** Called when work in the workspace's threads starts or ends, such as a message or a finished answer. */
  readonly changed: (workspaceId: string) => void;
  /** Searches one workspace; the recall tool of a thread only ever passes its own workspace. */
  readonly recall: (
    workspaceId: string,
    query: string,
    limit: number
  ) => Promise<{ readonly results: readonly RecallResult[] }>;
}

/** What the recall tool tells the agent about each search result. */
export interface RecallResult {
  readonly kind: string;
  readonly snippet: string;
  readonly threadId: string | null;
  readonly title: string;
  readonly updatedAt: number;
}

/** The thread registry in `golem.sqlite`, which `Workspaces` keeps. */
export type ThreadRegistry = Pick<
  Workspaces,
  | "channelsIn"
  | "registerThread"
  | "requireMember"
  | "thread"
  | "threadsIn"
  | "touchThread"
>;

/** One Pi Durable session per workspace, in `data/workspaces/<workspace>/session.sqlite`; a thread is one conversation in it. */
export class Threads {
  private readonly open = new Map<string, Promise<Harness>>();

  constructor(
    private readonly dataDirectory: string,
    private readonly llm: Llm,
    private readonly registry: ThreadRegistry,
    private readonly hooks: ThreadHooks
  ) {}

  /** Starts a thread in a channel with its first message, which also names it. */
  async create(
    workspaceId: string,
    user: User,
    channelId: string,
    text: string
  ): Promise<ThreadSummary> {
    this.registry.requireMember(workspaceId, user);
    const message = required(text, "Message");
    const conversation = await this.newConversation(workspaceId);
    const thread = this.registry.registerThread(workspaceId, {
      id: randomUUID(),
      channelId,
      title: titleOf(message),
      conversationId: conversation.id,
      createdBy: user.id,
    });
    await this.deliver(conversation, authored(user, message));
    return thread;
  }

  /** Sends a family member's message to a thread of their workspace; the agent answers in the background. */
  async send(threadId: string, user: User, text: string): Promise<void> {
    const thread = this.registry.thread(threadId, user);
    await this.deliver(
      await this.conversation(thread),
      authored(user, required(text, "Message"))
    );
    this.registry.touchThread(thread.id);
  }

  async messages(thread: ThreadRef): Promise<ThreadMessages> {
    const conversation = await this.conversation(thread);
    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    await watch.stop();
    return threadMessages(watch.value);
  }

  /** Calls `listener` with the current messages, then after every change, until the returned stop is called. */
  async watch(
    thread: ThreadRef,
    listener: (messages: ThreadMessages) => void
  ): Promise<() => Promise<void>> {
    const conversation = await this.conversation(thread);
    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    listener(threadMessages(watch.value));
    watch.start(async (view) => listener(threadMessages(view)));
    return async () => {
      await watch.stop();
    };
  }

  /** Changes whenever the thread gets a new entry, so search knows when to read it again. */
  async version(thread: ThreadRef): Promise<string> {
    const conversation = await this.conversation(thread);
    const { items } = await conversation.entries(
      { order: "descending" },
      1,
      undefined,
      BACKGROUND_CONTEXT
    );
    return String(items[0]?.id ?? 0);
  }

  async closeAll(): Promise<void> {
    const sessions = await Promise.allSettled(this.open.values());
    this.open.clear();
    for (const session of sessions) {
      if (session.status === "fulfilled") {
        await session.value.close(BACKGROUND_CONTEXT);
      }
    }
  }

  private async deliver(
    conversation: Conversation,
    input: {
      readonly content: string;
      readonly entry: {
        readonly kind: string;
        readonly data: Relay | Authored;
      };
      readonly requestId?: string;
    }
  ): Promise<void> {
    await this.useCurrentModel(conversation);
    await conversation.submit({ type: "input", ...input }, BACKGROUND_CONTEXT);
  }

  /**
   * A conversation for a new thread. One that is never registered, after an unknown channel or a crash, stays empty
   * and unseen.
   */
  private async newConversation(workspaceId: string): Promise<Conversation> {
    const harness = await this.session(workspaceId);
    return harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: this.currentModel(),
          thinkingLevel: this.llm.effort(),
          instructions: INSTRUCTIONS,
        },
      },
      BACKGROUND_CONTEXT
    );
  }

  private async conversation(thread: ThreadRef): Promise<Conversation> {
    const harness = await this.session(thread.workspaceId);
    const conversation = await harness.conversation(
      thread.conversationId as ConversationId,
      BACKGROUND_CONTEXT
    );
    if (!conversation) {
      throw notFound();
    }
    return conversation;
  }

  private session(workspaceId: string): Promise<Harness> {
    let session = this.open.get(workspaceId);
    if (!session) {
      session = this.openSession(workspaceId);
      this.open.set(workspaceId, session);
      session.catch(() => this.open.delete(workspaceId));
    }
    return session;
  }

  private async openSession(workspaceId: string): Promise<Harness> {
    const path = join(
      this.dataDirectory,
      "workspaces",
      workspaceId,
      "session.sqlite"
    );
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "golem",
        tools: [
          this.recallTool(workspaceId),
          this.listChannelsTool(workspaceId),
          this.readThreadTool(workspaceId),
          this.startThreadTool(workspaceId),
          this.sendToThreadTool(workspaceId),
        ],
      })
    );
    const harness = await Harness.open(
      await openNodeSqliteStorage(path),
      { models: this.llm.models, registry },
      BACKGROUND_CONTEXT
    );
    const changes = await harness.watchTaskGraph(BACKGROUND_CONTEXT);
    changes.start(async () => this.hooks.changed(workspaceId));
    // Continue runs that a previous process left unfinished.
    harness.resume();
    return harness;
  }

  /** Lets the agent search its own workspace: threads, notes, files, and captures. */
  private recallTool(workspaceId: string) {
    return defineTool({
      name: "recall",
      description:
        "Search everything in this workspace: earlier threads, notes, files, and captured mail or chats. Use it to recall facts, decisions, and what people said.",
      parameters: Type.Object({
        query: Type.String({ description: "What to look for, in plain words" }),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 20,
            description: "How many results; default 8",
          })
        ),
      }),
      replay: "safe",
      execute: async (args) => {
        const { results } = await this.hooks.recall(
          workspaceId,
          args.query,
          args.limit ?? 8
        );
        const threads = this.registry.threadsIn(workspaceId);
        const text = results.length
          ? results
              .map((result, number) => {
                const thread = threads.find(
                  (candidate) => candidate.id === result.threadId
                );
                const where = thread ? `, in ${threadLink(thread)}` : "";
                return `${number + 1}. [${result.kind}] ${result.title} (${day(result.updatedAt)}${where}): ${result.snippet}`;
              })
              .join("\n")
          : "Nothing found in this workspace.";
        return { output: [{ type: "text", text }] };
      },
    });
  }

  private listChannelsTool(workspaceId: string) {
    return defineTool({
      name: "list_channels",
      description:
        "List the channels of this workspace with their newest threads and thread ids.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        const text = this.registry
          .channelsIn(workspaceId)
          .map((channel) => {
            const threads = channel.threads
              .slice(0, 5)
              .map(
                (thread) => `- ${threadLink(thread)} (${day(thread.updatedAt)})`
              );
            return [`#${channel.name}`, ...threads].join("\n");
          })
          .join("\n");
        return { output: [{ type: "text", text }] };
      },
    });
  }

  private readThreadTool(workspaceId: string) {
    return defineTool({
      name: "read_thread",
      description: "Read the newest messages of a thread in this workspace.",
      parameters: Type.Object({
        thread: Type.String({ description: "The thread id" }),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 50,
            description: "How many messages; default 20",
          })
        ),
      }),
      replay: "safe",
      execute: async (args) => {
        const { messages } = await this.messages(
          this.threadIn(workspaceId, args.thread)
        );
        const text =
          messages
            .filter((message) => !message.streaming)
            .slice(-(args.limit ?? 20))
            .map((message) => `${message.author}: ${message.text}`)
            .join("\n") || "The thread has no messages.";
        return { output: [{ type: "text", text }] };
      },
    });
  }

  private startThreadTool(workspaceId: string) {
    return defineTool({
      name: "start_thread",
      description:
        "Start a new thread in this channel or another channel of the workspace, with a first message. The agent of the new thread answers it there.",
      parameters: Type.Object({
        message: Type.String({ description: "The first message" }),
        channel: Type.Optional(
          Type.String({
            description: "The channel name; default this thread's channel",
          })
        ),
        title: Type.Optional(
          Type.String({ description: "Default: the first line of the message" })
        ),
      }),
      // A rerun after a crash finds the thread and the message it made before.
      replay: "safe",
      execute: async (args, api) => {
        const { from, hops } = await this.relayFrom(
          workspaceId,
          api.conversationId
        );
        const channels = this.registry.channelsIn(workspaceId);
        const name = args.channel?.replace(/^#/, "").toLowerCase();
        const channel = name
          ? channels.find((candidate) => candidate.name === name)
          : channels.find((candidate) => candidate.id === from.channelId);
        if (!channel) {
          throw new Error(
            `There is no channel #${name}. list_channels shows the channels.`
          );
        }
        const id = randomUUIDv5(`golem:${workspaceId}:${api.taskId}`, "url");
        let thread = this.registry
          .threadsIn(workspaceId)
          .find((candidate) => candidate.id === id);
        if (!thread) {
          const conversation = await this.newConversation(workspaceId);
          thread = {
            ...this.registry.registerThread(workspaceId, {
              id,
              channelId: channel.id,
              title: titleOf(args.title || args.message),
              conversationId: conversation.id,
              createdBy: "golem",
            }),
            workspaceId,
            conversationId: conversation.id,
          };
        }
        await this.deliver(
          await this.conversation(thread),
          relayed(from, args.message, hops, `relay:${api.taskId}`)
        );
        return {
          output: [
            {
              type: "text",
              text: `Started ${threadLink(thread)} in #${channel.name}.`,
            },
          ],
        };
      },
    });
  }

  private sendToThreadTool(workspaceId: string) {
    return defineTool({
      name: "send_to_thread",
      description:
        "Send a message to another thread of this workspace. Its agent answers there, and can send the answer back to this thread.",
      parameters: Type.Object({
        thread: Type.String({ description: "The thread id" }),
        message: Type.String(),
      }),
      // The request id makes a rerun after a crash find the message it sent before.
      replay: "safe",
      execute: async (args, api) => {
        const { from, hops } = await this.relayFrom(
          workspaceId,
          api.conversationId
        );
        const target = this.threadIn(workspaceId, args.thread);
        if (target.id === from.id) {
          throw new Error("That is this thread. Answer here instead.");
        }
        await this.deliver(
          await this.conversation(target),
          relayed(from, args.message, hops, `relay:${api.taskId}`)
        );
        this.registry.touchThread(target.id);
        return {
          output: [{ type: "text", text: `Sent to ${threadLink(target)}.` }],
        };
      },
    });
  }

  /**
   * The thread a tool runs in, and how many times the message it answers already passed between threads. Refuses at
   * `MAX_HOPS`, so that agents cannot keep sending each other messages.
   */
  private async relayFrom(
    workspaceId: string,
    conversationId: ConversationId
  ): Promise<{ from: ThreadSummary & ThreadRef; hops: number }> {
    const from = this.registry
      .threadsIn(workspaceId)
      .find((thread) => thread.conversationId === conversationId);
    if (!from) {
      throw new Error("Only a thread can send to other threads.");
    }
    const conversation = await this.conversation(from);
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await conversation.entries(
        { order: "descending" },
        50,
        cursor,
        BACKGROUND_CONTEXT
      );
      const input = page.items.find(
        (entry) => entry.kind === AUTHORED || entry.kind === RELAYED
      );
      if (input) {
        const hops =
          input.kind === RELAYED ? (input.data as unknown as Relay).hops : 0;
        if (hops >= MAX_HOPS) {
          throw new Error(
            "This message already passed between threads. Answer here instead."
          );
        }
        return { from, hops };
      }
      cursor = page.next;
    } while (cursor);
    return { from, hops: 0 };
  }

  /** A thread of this workspace, by the id an agent gave. */
  private threadIn(
    workspaceId: string,
    threadId: string
  ): ThreadSummary & ThreadRef {
    const thread = this.registry
      .threadsIn(workspaceId)
      .find((candidate) => candidate.id === threadId);
    if (!thread) {
      throw new Error(`There is no thread ${threadId} in this workspace.`);
    }
    return thread;
  }

  /** Threads follow the model and effort chosen in settings, also after they change. */
  private async useCurrentModel(conversation: Conversation): Promise<void> {
    const model = this.currentModel();
    const thinkingLevel = this.llm.effort();
    const view = await conversation.watch(BACKGROUND_CONTEXT);
    await view.stop();
    const stored = view.value.docs["pi.agent"] as AgentState | undefined;
    if (
      stored?.model?.provider !== model.provider ||
      stored.model.modelId !== model.modelId ||
      stored.thinkingLevel !== thinkingLevel
    ) {
      await conversation.configure(
        { model, thinkingLevel },
        BACKGROUND_CONTEXT
      );
    }
  }

  private currentModel() {
    return { provider: this.llm.providerId, modelId: this.llm.model() };
  }
}

export function threadMessages(view: ConversationView): ThreadMessages {
  const messages: Message[] = [];
  for (const entry of view.entries) {
    const model = entry.model?.[0];
    if (entry.kind === AUTHORED) {
      const data = entry.data as {
        authorId: string;
        author: string;
        text: string;
      };
      const time = (model as UserMessage | undefined)?.timestamp ?? 0;
      messages.push({
        id: String(entry.id),
        authorId: data.authorId,
        author: data.author,
        agent: false,
        text: data.text,
        time,
        failed: false,
        streaming: false,
      });
    } else if (entry.kind === RELAYED) {
      const data = entry.data as unknown as Relay;
      messages.push({
        id: String(entry.id),
        authorId: null,
        author: "Golem",
        agent: true,
        text: `From ${threadLink({ id: data.fromThreadId, title: data.fromTitle })}: ${data.text}`,
        time: (model as UserMessage | undefined)?.timestamp ?? 0,
        failed: false,
        streaming: false,
      });
    } else if (model?.role === "assistant") {
      messages.push(agentMessage(String(entry.id), model, false));
    }
  }
  const live = (view.docs["pi.live"] ?? {}) as {
    generation?: { message?: AssistantMessage };
    tools?: Record<string, unknown>;
  };
  if (live.generation?.message) {
    messages.push(agentMessage("streaming", live.generation.message, true));
  }
  const running =
    live.generation !== undefined || Object.keys(live.tools ?? {}).length > 0;
  // A tool-only turn has no text to show.
  return {
    messages: messages.filter(
      (message) => message.text !== "" || message.streaming
    ),
    running,
  };
}

function agentMessage(
  id: string,
  message: AssistantMessage,
  streaming: boolean
): Message {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const failed =
    !streaming && text === "" && message.errorMessage !== undefined;
  return {
    id,
    authorId: null,
    author: "Golem",
    agent: true,
    text: failed ? message.errorMessage! : text,
    time: message.timestamp,
    failed,
    streaming,
  };
}

interface Authored extends JsonObject {
  readonly author: string;
  readonly authorId: string;
  readonly text: string;
}

function authored(user: User, text: string) {
  const data: Authored = { authorId: user.id, author: user.name, text };
  return { content: `${user.name}: ${text}`, entry: { kind: AUTHORED, data } };
}

/** A message from the agent of `from` to another thread; `hops` counts the passes before this one. */
function relayed(
  from: ThreadSummary & ThreadRef,
  text: string,
  hops: number,
  requestId: string
) {
  const data: Relay = {
    fromThreadId: from.id,
    fromTitle: from.title,
    hops: hops + 1,
    text,
  };
  return {
    content: `Golem from ${threadLink(from)}: ${text}`,
    entry: { kind: RELAYED, data },
    requestId,
  };
}

/** A thread as the agent writes it, `[title](thread:<id>)`, which the web and iOS show as a link to the thread. */
function threadLink(thread: {
  readonly id: string;
  readonly title: string;
}): string {
  return `[${thread.title.replace(/[[\]\n]/g, " ")}](thread:${thread.id})`;
}

function titleOf(text: string): string {
  const firstLine = text.split("\n")[0]!;
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

function day(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

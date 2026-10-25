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
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
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
const INSTRUCTIONS =
  "You are Golem, a family assistant. Several family members can write in one thread; each message starts with its author's name. Answer concisely. Use the recall tool to look up anything said or stored earlier in this workspace before saying you do not know.";

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
  readonly title: string;
  readonly updatedAt: number;
}

/** The thread registry in `golem.sqlite`, which `Workspaces` keeps. */
export type ThreadRegistry = Pick<
  Workspaces,
  "registerThread" | "requireMember" | "thread" | "touchThread"
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
    const firstLine = message.split("\n")[0]!;
    const title =
      firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
    const harness = await this.session(workspaceId);
    // A conversation that is never registered, after an unknown channel or a crash, stays empty and unseen.
    const conversation = await harness.createConversation(
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
    const thread = this.registry.registerThread(
      workspaceId,
      user,
      channelId,
      title,
      conversation.id
    );
    await this.deliver(conversation, user, message);
    return thread;
  }

  /** Sends a family member's message to a thread of their workspace; the agent answers in the background. */
  async send(threadId: string, user: User, text: string): Promise<void> {
    const thread = this.registry.thread(threadId, user);
    await this.deliver(
      await this.conversation(thread),
      user,
      required(text, "Message")
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
    user: User,
    text: string
  ): Promise<void> {
    await this.useCurrentModel(conversation);
    await conversation.submit(
      {
        type: "input",
        content: `${user.name}: ${text}`,
        entry: {
          kind: AUTHORED,
          data: { authorId: user.id, author: user.name, text },
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
      defineExtension({ name: "golem", tools: [this.recallTool(workspaceId)] })
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
        const text = results.length
          ? results
              .map((result, number) => {
                const when = new Date(result.updatedAt)
                  .toISOString()
                  .slice(0, 10);
                return `${number + 1}. [${result.kind}] ${result.title} (${when}): ${result.snippet}`;
              })
              .join("\n")
          : "Nothing found in this workspace.";
        return { output: [{ type: "text", text }] };
      },
    });
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

import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
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
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  DEFAULT_IMAGE_LIMITS,
  type ImageProcessor,
} from "@earendil-works/pi-durable/tools";
import { randomUUIDv5 } from "bun";
import type { Artifacts } from "../artifacts/artifacts.ts";
import type { Browser } from "../browser/browser.ts";
import type { Hands } from "../hands/hands.ts";
import type {
  Integrations,
  WorkspaceTool,
} from "../integrations/integrations.ts";
import type { Llm } from "../llm/llm.ts";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
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
  readonly files: readonly FileRef[];
  readonly id: string;
  readonly streaming: boolean;
  readonly text: string;
  readonly time: number;
}

/** A file of a thread, saved as `threads/<thread>/files/<id>-<name>`: attached to a message, or uploaded to the thread. */
export interface ThreadFile {
  /** A UUIDv7, so files sort by time. */
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly time: number;
}

export type FileRef = Pick<ThreadFile, "id" | "name">;

export interface ThreadMessages {
  readonly messages: readonly Message[];
  readonly running: boolean;
}

const AUTHORED = "golem.message";
/** A message the agent of another thread sent to this one. */
const RELAYED = "golem.relay";
/** Work that no person typed, such as a routine run; the transcript leaves it out. */
const TASK = "golem.task";
/** How often one person's message may pass between threads: a question to another thread, and its answer back. */
const MAX_HOPS = 2;
/** How much of a file's text read_file gives the agent at once. */
const MAX_READ_CHARACTERS = 100_000;
const FILE_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/;
const INSTRUCTIONS =
  "You are Golem, a family assistant. Several family members can write in one thread; each message starts with its author's name. Answer concisely. Use the recall tool to look up anything said or stored earlier in this workspace before saying you do not know. The workspace has channels, and each channel has threads. You can list them, read a thread, start a thread in any channel, and send a message to another thread. The agent of that thread answers there, and can send its answer back with send_to_thread. People attach files to their messages or upload them to the thread; list_files shows them and read_file reads them. When people want a page to share or a small app, such as an invite, a schedule, a poll, or a game, make an artifact. Whenever you mention a thread, write it as the link the tools give, exactly: [title](thread:<id>). People see it as a link that opens the thread. Never write a thread id on its own.";
/** Added for the model to a message spoken in a conversation on the phone, whose answer is read aloud. */
const VOICE =
  "(Spoken in a conversation: your words are read aloud as you write them, and they may not look at the screen. Before you use tools, say in one short sentence what you are about to do. Write the way you speak: plain sentences, no Markdown, tables, lists, code blocks, or links unless they ask. Keep answers to one to three sentences unless they ask for more. Your final answer continues from what you already said in this turn; never repeat it. Their words come from speech recognition and can have sound-alike mistakes.)";

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
  /** Tools of the modules after threads, such as routines, for the agents of a workspace. */
  readonly tools: (workspaceId: string) => readonly ToolRegistration[];
  /** The text of a document or PDF for read_file; `null` for a kind of file without text. */
  readonly read: (path: string) => Promise<string | null>;
  /** A JPEG of a picture that read_file cannot open as it is, such as HEIC; `null` when it cannot convert it. */
  readonly picture: (path: string) => Promise<Uint8Array | null>;
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
  | "setChannelSummary"
  | "thread"
  | "threadsIn"
  | "touchThread"
>;

/** Where a thread's folder is: `workspaces/<workspace>/threads/<thread>/`. */
export type ThreadLocation = Pick<ThreadRef, "id" | "workspaceId">;

/** The machines of a workspace, which its agents use through the hands tools. */
export type ThreadHands = Pick<Hands, "section" | "tools">;

/** The connectors of a workspace, which its agents use through their tools. */
export type ThreadIntegrations = Pick<Integrations, "tools">;

/** The artifacts of a workspace, which its agents make with their tools. */
export type ThreadArtifacts = Pick<Artifacts, "tools">;

/** The browser that agents visit websites with. */
export type ThreadBrowser = Pick<Browser, "tools">;

/** One Pi Durable session per workspace, in `data/workspaces/<workspace>/session.sqlite`; a thread is one conversation in it. */
export class Threads {
  private readonly open = new Map<string, Promise<Harness>>();
  private images: Promise<ImageProcessor> | undefined;

  constructor(
    private readonly dataDirectory: string,
    private readonly llm: Llm,
    private readonly registry: ThreadRegistry,
    private readonly hands: ThreadHands,
    private readonly integrations: ThreadIntegrations,
    private readonly artifacts: ThreadArtifacts,
    private readonly browser: ThreadBrowser,
    private readonly hooks: ThreadHooks
  ) {}

  /** Starts a thread in a channel with its first message and files; the message, or else the first file, names it. */
  async create(
    workspaceId: string,
    user: User,
    channelId: string,
    text: string | undefined,
    files: readonly File[] = []
  ): Promise<ThreadSummary> {
    this.registry.requireMember(workspaceId, user);
    const message = messageText(text, files);
    const conversation = await this.newConversation(workspaceId);
    const thread = this.registry.registerThread(workspaceId, {
      id: randomUUID(),
      channelId,
      title: titleOf(message || files[0]!.name),
      conversationId: conversation.id,
      createdBy: user.id,
    });
    const attached = await this.save({ workspaceId, id: thread.id }, files);
    await this.deliver(conversation, authored(user, message, attached));
    return thread;
  }

  /**
   * Sends a family member's message and files to a thread of their workspace; the agent answers in the background. A
   * `voice` message is spoken in a conversation: the agent's answer is read aloud, and it steers a run at work.
   */
  async send(
    threadId: string,
    user: User,
    text: string | undefined,
    files: readonly File[] = [],
    voice = false
  ): Promise<void> {
    const thread = this.registry.thread(threadId, user);
    const message = messageText(text, files);
    const attached = await this.save(thread, files);
    const input = authored(user, message, attached);
    await this.deliver(
      await this.conversation(thread),
      voice
        ? {
            ...input,
            content: `${input.content}\n\n${VOICE}`,
            whenBusy: "steer",
          }
        : input
    );
    this.registry.touchThread(thread.id);
  }

  /** Starts a thread that an agent owns, such as the thread of a routine, without a first message. */
  async startAgentThread(
    workspaceId: string,
    channelId: string,
    title: string
  ): Promise<ThreadSummary & ThreadRef> {
    const conversation = await this.newConversation(workspaceId);
    const thread = this.registry.registerThread(workspaceId, {
      id: randomUUID(),
      channelId,
      title: titleOf(title),
      conversationId: conversation.id,
      createdBy: "golem",
    });
    return { ...thread, workspaceId, conversationId: conversation.id };
  }

  /**
   * Gives a thread's agent work that no person typed, and waits for its answer. The transcript shows only the answer,
   * and not an answer of exactly `QUIET`. Returns the answer, or `null` for a quiet one. `requestId` makes a retry
   * find the work it gave before.
   */
  async instruct(
    thread: ThreadRef,
    text: string,
    requestId: string
  ): Promise<string | null> {
    const conversation = await this.conversation(thread);
    await this.useCurrentModel(conversation);
    const submission = await conversation.submit(
      {
        type: "input",
        content: text,
        entry: { kind: TASK, data: {} },
        requestId,
      },
      BACKGROUND_CONTEXT
    );
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    const { messages } = await this.messages(thread);
    if (settled.status !== "done") {
      // A model that fails leaves its error as the newest message.
      const failed = messages.at(-1)?.failed ? messages.at(-1)!.text : null;
      throw new Error(failed ?? `The agent did not answer: ${settled.reason}`);
    }
    const answer = messages.find(
      (message) => message.id === String(settled.answer)
    );
    if (!answer) {
      return null;
    }
    this.registry.touchThread(thread.id);
    if (answer.failed) {
      throw new Error(answer.text);
    }
    return answer.text;
  }

  /** Adds files to a thread without a message; its agent finds them with list_files. Returns all files of the thread. */
  async upload(
    threadId: string,
    user: User,
    files: readonly File[]
  ): Promise<ThreadFile[]> {
    const thread = this.registry.thread(threadId, user);
    if (files.length === 0) {
      throw new HttpError(400, "Choose a file");
    }
    await this.save(thread, files);
    this.hooks.changed(thread.workspaceId);
    return this.files(thread);
  }

  /** The files of a thread, oldest first. */
  async files(thread: ThreadLocation): Promise<ThreadFile[]> {
    const directory = this.filesDirectory(thread);
    const entries = await readdir(directory).catch(() => []);
    const files: ThreadFile[] = [];
    for (const entry of entries.sort()) {
      const match = FILE_NAME.exec(entry);
      // A file deleted while listing is left out.
      const stats = match
        ? await stat(join(directory, entry)).catch(() => null)
        : null;
      if (match && stats) {
        files.push({
          id: match[1]!,
          name: match[2]!,
          size: stats.size,
          time: Math.round(stats.mtimeMs),
        });
      }
    }
    return files;
  }

  /** Deletes a file of a thread; messages keep its name. Returns the files left. */
  async deleteFile(
    threadId: string,
    user: User,
    fileId: string
  ): Promise<ThreadFile[]> {
    const thread = this.registry.thread(threadId, user);
    await rm((await this.file(thread, fileId)).path);
    this.hooks.changed(thread.workspaceId);
    return this.files(thread);
  }

  /** The path and name of a file of a thread; not found for an id of another thread. */
  async file(
    thread: ThreadLocation,
    fileId: string
  ): Promise<{ readonly path: string; readonly name: string }> {
    const file = (await this.files(thread)).find(
      (candidate) => candidate.id === fileId
    );
    if (!file) {
      throw notFound();
    }
    return {
      path: join(this.filesDirectory(thread), `${file.id}-${file.name}`),
      name: file.name,
    };
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

  private async save(
    thread: ThreadLocation,
    files: readonly File[]
  ): Promise<FileRef[]> {
    if (files.length === 0) {
      return [];
    }
    const directory = this.filesDirectory(thread);
    await mkdir(directory, { recursive: true });
    const saved: FileRef[] = [];
    for (const file of files) {
      const ref = { id: Bun.randomUUIDv7(), name: fileName(file.name) };
      await Bun.write(join(directory, `${ref.id}-${ref.name}`), file);
      saved.push(ref);
    }
    return saved;
  }

  private filesDirectory(thread: ThreadLocation): string {
    return join(
      this.dataDirectory,
      "workspaces",
      thread.workspaceId,
      "threads",
      thread.id,
      "files"
    );
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
      readonly whenBusy?: "steer";
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
          this.listFilesTool(workspaceId),
          this.readFileTool(workspaceId),
          this.setChannelSummaryTool(workspaceId),
          ...this.hands.tools(workspaceId),
          ...this.integrations.tools(workspaceId).map(connectorTool),
          ...this.artifacts.tools(workspaceId),
          ...this.browser.tools(workspaceId),
          ...this.llm.tools(),
          ...this.hooks.tools(workspaceId),
        ],
        sections: [this.hands.section(workspaceId)],
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

  private listFilesTool(workspaceId: string) {
    return defineTool({
      name: "list_files",
      description:
        "List the files of this thread: attached to messages or uploaded to the thread.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api) => {
        const files = await this.files(
          this.threadOf(workspaceId, api.conversationId)
        );
        const text =
          files
            .map(
              (file) =>
                `- ${file.name} (file ${file.id}, ${Math.ceil(file.size / 1024)} KB, ${day(file.time)})`
            )
            .join("\n") || "This thread has no files.";
        return { output: [{ type: "text", text }] };
      },
    });
  }

  private readFileTool(workspaceId: string) {
    return defineTool({
      name: "read_file",
      description:
        "Read a file of this thread: the text of a document, sheet, slides, or PDF, or a picture.",
      parameters: Type.Object({
        file: Type.String({ description: "The file id" }),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const thread = this.threadOf(workspaceId, api.conversationId);
        const { path, name } = await this.file(thread, args.file).catch(() => {
          throw new Error(
            `There is no file ${args.file} in this thread. list_files shows the files.`
          );
        });
        const type = Bun.file(path).type.split(";")[0]!;
        if (type.startsWith("image/")) {
          this.images ??= createNodePhotonImages();
          const images = await this.images;
          let image = await images.prepare(
            await Bun.file(path).bytes(),
            type,
            DEFAULT_IMAGE_LIMITS
          );
          if (!image) {
            // Photon cannot decode HEIC, the iPhone's format.
            const jpeg = await this.hooks.picture(path);
            image = jpeg
              ? await images.prepare(jpeg, "image/jpeg", DEFAULT_IMAGE_LIMITS)
              : undefined;
          }
          if (!image) {
            throw new Error(`Golem cannot open the picture ${name}.`);
          }
          return {
            output: [
              { type: "image", data: image.data, mimeType: image.mimeType },
            ],
          };
        }
        const text = await this.hooks.read(path);
        if (text === null) {
          throw new Error(
            `Golem cannot read ${name}: it is not a document, PDF, or picture.`
          );
        }
        const cut =
          text.length > MAX_READ_CHARACTERS
            ? `${text.slice(0, MAX_READ_CHARACTERS)}\n[The rest of the ${text.length} characters is cut.]`
            : text;
        return {
          output: [{ type: "text", text: cut || "The file is empty." }],
        };
      },
    });
  }

  private setChannelSummaryTool(workspaceId: string) {
    return defineTool({
      name: "set_channel_summary",
      description:
        "Replace the summary of a channel, which people see on the channel's details page: what the channel is for and what goes on in its threads now. Keep it short.",
      parameters: Type.Object({
        summary: Type.String({ maxLength: 2000 }),
        channel: Type.Optional(
          Type.String({
            description: "The channel name; default this thread's channel",
          })
        ),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const channels = this.registry.channelsIn(workspaceId);
        const name = args.channel?.replace(/^#/, "").toLowerCase();
        const channelId = name
          ? channels.find((candidate) => candidate.name === name)?.id
          : this.threadOf(workspaceId, api.conversationId).channelId;
        if (!channelId) {
          throw new Error(
            `There is no channel #${name}. list_channels shows the channels.`
          );
        }
        this.registry.setChannelSummary(workspaceId, channelId, args.summary);
        return { output: [{ type: "text", text: "Saved the summary." }] };
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
    const from = this.threadOf(workspaceId, conversationId);
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

  /** The thread of the conversation a tool runs in. */
  private threadOf(
    workspaceId: string,
    conversationId: ConversationId
  ): ThreadSummary & ThreadRef {
    const thread = this.registry
      .threadsIn(workspaceId)
      .find((candidate) => candidate.conversationId === conversationId);
    if (!thread) {
      throw new Error("This tool works only in a thread.");
    }
    return thread;
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
      const data = entry.data as unknown as Authored;
      const time = (model as UserMessage | undefined)?.timestamp ?? 0;
      messages.push({
        id: String(entry.id),
        authorId: data.authorId,
        author: data.author,
        agent: false,
        text: data.text,
        // Messages from before files have none.
        files: data.files ?? [],
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
        files: [],
        time: (model as UserMessage | undefined)?.timestamp ?? 0,
        failed: false,
        streaming: false,
      });
    } else if (model?.role === "assistant") {
      const message = agentMessage(String(entry.id), model, false);
      // The answer to a task that needs nobody's attention.
      if (message.text.trim() !== "QUIET") {
        messages.push(message);
      }
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
      (message) =>
        message.text !== "" || message.files.length > 0 || message.streaming
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
    files: [],
    time: message.timestamp,
    failed,
    streaming,
  };
}

interface Authored extends JsonObject {
  readonly author: string;
  readonly authorId: string;
  readonly text: string;
  readonly files: FileRef[];
}

/** The agent sees the attached files by name and id, which read_file takes. */
function authored(user: User, text: string, files: readonly FileRef[]) {
  const data: Authored = {
    authorId: user.id,
    author: user.name,
    text,
    files: [...files],
  };
  const attached = files.length
    ? `\nAttached: ${files.map((file) => `${file.name} (file ${file.id})`).join(", ")}`
    : "";
  return {
    content: `${user.name}: ${text}${attached}`,
    entry: { kind: AUTHORED, data },
  };
}

/** A message needs text, files, or both. */
function messageText(text: string | undefined, files: readonly File[]): string {
  return files.length > 0 ? (text ?? "").trim() : required(text, "Message");
}

/** A name that stays one file in the thread's folder: no folders, control characters, or leading dots. */
function fileName(name: string): string {
  const clean = name
    .split(/[/\\]/)
    .at(-1)!
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return clean.slice(-200) || "file";
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

/** A connector's tool for the agent; its JSON result is the text the agent reads. */
function connectorTool(tool: WorkspaceTool) {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (args, _api, context) => {
      const result = await tool.execute(args, context.abortSignal);
      return {
        output: [{ type: "text", text: JSON.stringify(result) ?? "null" }],
      };
    },
  });
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

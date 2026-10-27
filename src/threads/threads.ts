import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
  CODEMODE_OPTIONS_PREFIX,
  CodemodeSandbox,
  parseCodemodeSource,
} from "@earendil-works/pi-codemode";
import {
  type AgentState,
  type Conversation,
  type ConversationId,
  type ConversationView,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryId,
  type EntryRecord,
  Harness,
  type JsonObject,
  type Registry,
  section,
  type TaskGraph,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  type CodemodeNamespace,
  createCodemodeExtension,
} from "@earendil-works/pi-durable/codemode";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  DEFAULT_IMAGE_LIMITS,
  type ImageProcessor,
} from "@earendil-works/pi-durable/tools";
import { randomUUIDv5 } from "bun";
import type { Artifacts } from "../artifacts/artifacts.ts";
import type { Browser } from "../browser/browser.ts";
import { type Hands, type Machine, readOnlyCommand } from "../hands/hands.ts";
import type {
  Integrations,
  WorkspaceTool,
} from "../integrations/integrations.ts";
import type { Llm } from "../llm/llm.ts";
import type { Notifications } from "../notifications/notifications.ts";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
import type {
  Channel,
  ThreadRef,
  ThreadSummary,
  Workspaces,
} from "../workspaces/workspaces.ts";
import { type Brief, type BriefMessage, Briefs } from "./brief.ts";
import { Memory, type Said } from "./memory.ts";

export type { Brief } from "./brief.ts";

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
  /** What the agent did before this answer, in order; null for people and for an answer without work. */
  readonly work: Work | null;
}

export interface Work {
  readonly startedAt: number;
  /** Null while the agent works. */
  readonly endedAt: number | null;
  /** Someone stopped the agent before it answered. */
  readonly stopped: boolean;
  readonly steps: readonly Step[];
}

/**
 * A thought, what the agent said between tool calls, or a tool call. A tool call's text is the thread link in its
 * result, or else the values of its arguments on one line.
 */
export interface Step {
  readonly kind: "thinking" | "text" | "tool";
  readonly text: string;
  readonly tool: string | null;
  /** A tool call's arguments as JSON, and the start of its result once it has one. */
  readonly input: string | null;
  readonly output: string | null;
  readonly running: boolean;
  readonly failed: boolean;
}

/**
 * A file saved as `<id>-<name>` in the folder of its place: uploaded there, or attached to a message. A channel's
 * files are for every thread of the channel, also after a thread is settled.
 */
export interface SavedFile {
  /** A UUIDv7, so files sort by time. */
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly time: number;
}

export type FileRef = Pick<SavedFile, "id" | "name">;

export interface ThreadMessages {
  readonly messages: readonly Message[];
  readonly running: boolean;
  /** What the agent waits for a person to allow. */
  readonly approvals: readonly Approval[];
}

/**
 * A serious action that waits for one person: a change on a machine in a turn that read content no member wrote, in
 * a turn that no person watches, or on a machine that another person paired; or a routine's standing permission to
 * change a machine in each run.
 */
export interface Approval {
  readonly id: string;
  readonly tool: string;
  /** What the action does, such as `Run on bender: make deploy`. */
  readonly text: string;
  /** The person who may allow it; null for any member. */
  readonly approverId: string | null;
  readonly expiresAt: number;
}

/** An approval and how its answer reaches the call that waits. */
interface PendingApproval {
  readonly approval: Approval;
  readonly threadId: string;
  readonly answer: (allow: boolean, scope: "once" | "turn", by: User) => void;
}

const AUTHORED = "golem.message";
/** A message the agent of another thread sent to this one. */
const RELAYED = "golem.relay";
/** Work that no person typed, such as a routine run; the transcript leaves it out. */
const TASK = "golem.task";
/** Someone stopped the agent; its `at` ends the agent's work in the transcript. */
const STOPPED = "golem.stopped";
/** The turn took in content that no member wrote, such as a web page, so changes on machines wait for a person. */
const EXPOSED = "golem.exposed";
/** A person allowed the rest of the turn on one machine. */
const ALLOWED = "golem.allowed";
/** The tools whose results come from outside the workspace's members. */
const EXPOSING = new Set([
  "web_search",
  "browser_run",
  "artifacts_data",
  "routines_test_script",
]);
/** The tools that change a machine, which `approved` gates. */
const CHANGES_MACHINE = new Set([
  "hands_exec",
  "hands_job_start",
  "hands_write",
  "hands_edit",
  "hands_copy_file",
]);
/** How long an action waits for a person to allow it. */
const APPROVAL_WAIT = 10 * 60_000;
/** The longest a codemode script runs, with its tool calls; above `APPROVAL_WAIT`, so a script outlasts a wait. */
const SCRIPT_DEADLINE = 15 * 60_000;
/** How often one person's message may pass between threads: a question to another thread, and its answer back. */
const MAX_HOPS = 2;
/** How much of a file's text read_file gives the agent at once. */
const MAX_READ_CHARACTERS = 100_000;
const FILE_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/;
/** The search uri of a saved file: in a channel's `files/`, or in the workspace's own. */
const FILE_URI = /^(?:channels\/[^/]+\/)?files\/([0-9a-f-]{36})-/;
/** The groups of the tools that the model calls only from codemode scripts, by their name's prefix. */
const NAMESPACES: CodemodeNamespace[] = [
  {
    name: "hands",
    prefix: "hands_",
    description:
      "The workspace's machines: run commands and long jobs, read, write, and edit their files, and copy workspace files to them.",
  },
  {
    name: "artifacts",
    prefix: "artifacts_",
    description:
      "Pages and small apps for people, such as invites, polls, and games: make, change, and read them and their data.",
  },
  {
    name: "browser",
    prefix: "browser_",
    description: "A web browser: open pages, click, type, and read them.",
  },
  {
    name: "routines",
    prefix: "routines_",
    description:
      "Work that runs on a schedule, with an optional script that collects what is new.",
  },
  {
    name: "reminders",
    prefix: "reminders_",
    description: "One-time reminders for people at a time they name.",
  },
];
const INSTRUCTIONS =
  "You are Golem, a family assistant. Several family members can write in one thread; each message starts with its author's name. Answer concisely. Be useful first and witty second: explain complex things simply and with curiosity, as Richard Feynman did; be warm, humane, and lightly funny, as Terry Pratchett was; and add deadpan absurdity rarely, as Douglas Adams did. Use these only as broad traits; never claim to be or imitate a real person. Answer the question before you make a joke. Keep humor short and kind, and prefer one dry aside to a funny paragraph. Do not joke about sensitive, urgent, health, legal, money, or failure matters: when the answer is serious, be serious. Use the recall tool to look up anything said or stored earlier in this workspace before saying you do not know. The workspace has channels, and each channel has threads. You can list them, read a thread, start a thread in any channel, and send a message to another thread. The agent of that thread answers there. When the agent of another thread gives you work, do it in this thread and answer here as you answer the family. When you finish, or when you need an answer from the family, send a short result to that thread with send_to_thread: what you did, what you found, and the links of files and artifacts. Files and artifacts belong to the channel: every thread of the channel sees them, also after a thread is settled. People attach files to their messages or upload them to the channel; list_files shows them and read_file reads them. Your answers are the memory: the brief of the channel and the memory of the workspace keep only the messages of people and your answers, never what you gave to tools or what tools gave you. So say in your answer what will matter later: what you did, what you found, the decisions and who made them, names, dates, and numbers, and the link of each file or artifact you made. When something changes, say it plainly, such as 'Rivalové: watched on 26 October', and the brief changes with it. Save content as a file when people will look it up later: what they ask you to save, store, or remember, the content of a web page, a recipe, a document, a how-to, or one thing of a list, such as a movie, a book, or a place. Save one Markdown file for each thing with save_file content and a name such as 'Pressure (2026).md', never one file or artifact for a whole list: the files and your answer are the list. Start the file with `# <title>`, then the facts, then `Source: <address>`. Copy text from a source as it is, and write your own words in the language of the people. Before you save, look with list_files and recall: when a file for the thing exists, do not save it again; say the change in your answer. Do not save decisions, wishes, plans, or status as files; say them in your answer. Do not save small talk or the steps of your work. Make an artifact only when people ask for a page to share or print, or a small app, such as an invite, a poll, or a game; when one for it exists, change it instead. An artifact never holds facts that no file or message has. Whenever you mention a thread, write it as the link the tools give, exactly: [title](thread:<id>). People see it as a link that opens the thread. Never write a thread id on its own. The channel section of these instructions has the brief of this thread's channel, which the model writes again from its threads, and the channel's threads: use it first, then read_thread and recall for more. Your answers show as Markdown: use headings, lists, tables, code blocks, and links when they make an answer clearer, and simple HTML such as <details>, <kbd>, or <mark>; scripts, styles, and forms are removed. Show a picture with ![what it shows](file:<id>) for a file of this channel. To show a picture from the web, a screenshot, or another picture of a machine or of your browser, save it with save_file first. Show an artifact in your answer with ![title](artifact:<id>), and link to it with [title](artifact:<id>). For a page that needs scripts, styles, or input, make an artifact and show it. When people want a PDF, such as an invite or a schedule to print, make an artifact and save it as a PDF with save_file. To make another kind of file or to change a file, use a machine: hands_copy_file puts a file there, and save_file brings the result back. You call the tools of channels, threads, files, and web search yourself. You call all other tools from a codemode script as `await tools.<name>(args)`: machines, artifacts, the browser, routines, reminders, and connected services such as shops. The codemode section lists them by namespace; describeNamespace() and searchTools() find the rest.";
/** Added to `INSTRUCTIONS` for the orchestrator, the one thread of a workspace that never ends. */
const ORCHESTRATOR =
  "This thread is the orchestrator of the workspace: one thread that never ends, where the family talks to you first. Answer here only a simple question that you can answer at once from your memory, with recall, or with one quick search, and do only small changes, such as marking a movie as watched or setting a reminder. Give all other work to a thread in the channel it belongs to: work that needs the browser or a machine, more than one search, saving files, an artifact, a routine, or more than one step. When a thread is already about the work, send it there with send_to_thread; else start a thread with start_thread in the channel the work belongs to. When no channel fits, make one with create_channel. The agent of that thread sees only your message, so write all that it needs: the goal, the facts from this thread, and who asked. Then tell the family in one line which thread does the work, with its link, and end your turn; do not wait for the work. When an agent sends you its result, tell the family what came of it, short, with the links it gives. Your memory is the summary at the start of this thread: every message of every thread of the workspace, which zoom opens, and zoom() gives again with the newest messages. Use it before recall. To recommend or choose from what the family keeps, such as a movie for tonight, find it in your memory and with recall: the files have the details.";
/** The largest file that save_file copies from a machine. */
const MAX_MACHINE_FILE = 1024 ** 3;
/** Above about this many tokens of context, the orchestrator compacts after its turn, so each turn reads little. */
const ORCHESTRATOR_TOKENS = 48_000;
/** A compaction needs this many new messages since the one before, so a long message that stays cannot repeat it. */
const COMPACTION_MESSAGES = 8;
/** How long a workspace waits after a change before its new messages go to the memory and the briefs. */
const CATCH_UP_MS = 2000;
/** How often a workspace looks for channels whose briefs can take in their new messages. */
const BRIEF_CHECK_MS = 5 * 60_000;
/** A brief takes in a thread's new messages after the thread is quiet this long, or at once when it is settled. */
const BRIEF_QUIET_MS = 10 * 60_000;
/** The most threads that the channel section lists. */
const LISTED_THREADS = 30;
/** Added for the model to a message spoken in a conversation on the phone, whose answer is read aloud. */
const VOICE =
  "(Spoken in a conversation: your words are read aloud as you write them, and they may not look at the screen. Before you use tools, say in one short sentence what you are about to do. Write the way you speak: plain sentences, no Markdown, tables, lists, code blocks, or links unless they ask. Keep answers to one to three sentences unless they ask for more. Your final answer continues from what you already said in this turn; never repeat it. Their words come from speech recognition and can have sound-alike mistakes.)";

/** Where save_file takes a file from: one of these, with the name people see. */
interface SaveSource {
  readonly content?: string;
  readonly artifact?: string;
  readonly machine?: string;
  readonly path?: string;
  readonly browser_screenshot?: boolean;
  readonly url?: string;
  readonly name?: string;
}

/** A task that Golem gives an agent, such as a routine run or a reminder, and the member the turn is for. */
interface Task extends JsonObject {
  readonly requesterId: string | null;
  readonly requesterName: string | null;
  /** The machines whose changes the person allowed for every run of this work, such as a routine. */
  readonly machineIds: string[];
  /** Its text has content that no member wrote, such as what a routine's script read from a connector. */
  readonly exposed: boolean;
}

interface Relay extends JsonObject {
  readonly fromThreadId: string;
  readonly fromTitle: string;
  readonly hops: number;
  readonly text: string;
  readonly requesterId: string | null;
  readonly requesterName: string | null;
  /** The sending turn took in content that no member wrote, or no person watched it. */
  readonly exposed: boolean;
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
  readonly tools: (workspaceId: string) => Promise<readonly ToolRegistration[]>;
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
  readonly uri: string;
}

/** The thread registry in `golem.sqlite`, which `Workspaces` keeps. */
export type ThreadRegistry = Pick<
  Workspaces,
  | "addChannel"
  | "agentMember"
  | "channel"
  | "channelsIn"
  | "members"
  | "removeChannel"
  | "orchestratorOf"
  | "registerThread"
  | "requireMember"
  | "setChannelSummary"
  | "thread"
  | "threadsIn"
  | "touchThread"
>;

/**
 * Where files are kept: a channel's `channels/<channel>/files/`, or, for a null `channelId`, the workspace's own
 * `files/`, which keeps the orchestrator's files because the orchestrator belongs to no channel.
 */
export interface FilePlace {
  readonly workspaceId: string;
  readonly channelId: string | null;
}

/** The machines of a workspace, which its agents use through the hands tools. */
export type ThreadHands = Pick<
  Hands,
  "file" | "machineNamed" | "put" | "section" | "tools"
>;

/** The connectors of a workspace, which its agents use through their tools. */
export type ThreadIntegrations = Pick<Integrations, "tools" | "namespaces">;

/** The artifacts of a workspace, which its agents make with their tools. */
export type ThreadArtifacts = Pick<
  Artifacts,
  "content" | "inWorkspace" | "tools"
>;

/** The browser that agents visit websites with. */
export type ThreadBrowser = Pick<
  Browser,
  "download" | "pdf" | "screenshot" | "tools"
>;

/** The inboxes of the workspace's people, which agents fill when something needs them. */
export type ThreadNotifications = Pick<Notifications, "notify">;

/** One Pi Durable session per workspace, in `data/workspaces/<workspace>/session.sqlite`; a thread is one conversation in it. */
export class Threads {
  private readonly open = new Map<string, Promise<Harness>>();
  /** The memory of each open workspace's orchestrator. */
  private readonly memories = new Map<string, Memory>();
  private readonly making = new Map<
    string,
    Promise<ThreadSummary & ThreadRef>
  >();
  /** The memory size at each orchestrator's last compaction, by workspace. */
  private readonly compacted = new Map<string, number>();
  /** The channel briefs of each open workspace. */
  private readonly briefs = new Map<string, Briefs>();
  /** The version of each thread whose messages the memory and the briefs know, by thread. */
  private readonly caughtUp = new Map<string, string>();
  /** The threads with messages that their channel's brief has not read, with the time of the newest, by channel. */
  private readonly unbriefed = new Map<string, Map<string, number>>();
  /** The channels whose brief the model writes now. */
  private readonly briefing = new Set<string>();
  private readonly catchUpTimers = new Map<string, Timer>();
  private readonly catchingUp = new Map<string, Promise<void>>();
  private readonly briefChecks: Timer[] = [];
  /** Stops the background work of all workspaces when Golem closes. */
  private readonly background = new AbortController();
  private images: Promise<ImageProcessor> | undefined;
  /** The extensions of each open workspace, which reloadTools changes. */
  private readonly registries = new Map<string, Registry>();
  /** Runs the agents' codemode scripts, each in its own worker. */
  private readonly sandbox = new CodemodeSandbox({
    memoryLimitBytes: 256 * 1024 * 1024,
  });
  /** The actions that wait for a person, by approval id; a wait lasts only as long as its call, so memory keeps them. */
  private readonly approvals = new Map<string, PendingApproval>();
  /** The thread streams that show approvals, by thread. */
  private readonly approvalWatchers = new Map<string, Set<() => void>>();

  constructor(
    private readonly dataDirectory: string,
    private readonly llm: Llm,
    private readonly registry: ThreadRegistry,
    private readonly hands: ThreadHands,
    private readonly integrations: ThreadIntegrations,
    private readonly artifacts: ThreadArtifacts,
    private readonly browser: ThreadBrowser,
    private readonly notifications: ThreadNotifications,
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
    const attached = await this.save({ workspaceId, channelId }, files);
    await this.deliver(
      workspaceId,
      conversation,
      authored(user, message, attached)
    );
    return thread;
  }

  /**
   * Sends a family member's message and files to a thread of their workspace; the agent answers in the background. A
   * `voice` message is spoken in a conversation: the agent's answer is read aloud, and it steers a run at work for
   * the same person.
   */
  async send(
    threadId: string,
    user: User,
    text: string | undefined,
    files: readonly File[] = [],
    voice = false,
    requestId?: string
  ): Promise<void> {
    const thread = this.registry.thread(threadId, user);
    const message = messageText(text, files);
    const attached = await this.save(this.placeOf(thread), files);
    // A retry with the same `requestId` finds the first submission, so a message that reached Golem once stays one.
    const input = { ...authored(user, message, attached), requestId };
    const conversation = await this.conversation(thread);
    // A steer joins the running turn, whose later tool calls then act for its author; so only that turn's person steers.
    const steer =
      voice &&
      (
        await this.requester(thread.workspaceId, conversation.id).catch(
          () => null
        )
      )?.id === user.id;
    await this.deliver(
      thread.workspaceId,
      conversation,
      voice
        ? {
            ...input,
            content: `${input.content}\n\n${VOICE}`,
            ...(steer ? { whenBusy: "steer" as const } : {}),
          }
        : input
    );
    this.registry.touchThread(thread.id);
  }

  /**
   * The workspace's thread that never ends and that nobody settles. The first call makes it, in the first channel,
   * which channel lists leave it out of.
   */
  async orchestrator(
    workspaceId: string,
    user: User
  ): Promise<ThreadSummary & ThreadRef> {
    this.registry.requireMember(workspaceId, user);
    const existing = this.registry.orchestratorOf(workspaceId);
    if (existing) {
      return existing;
    }
    let making = this.making.get(workspaceId);
    if (!making) {
      making = this.makeOrchestrator(workspaceId).finally(() =>
        this.making.delete(workspaceId)
      );
      this.making.set(workspaceId, making);
    }
    return making;
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
   * and not an answer of exactly `QUIET`, and the answer notifies the members `notify` names. Returns the answer, or
   * `null` for a quiet one. `requestId` makes a retry find the work it gave before.
   */
  async instruct(
    thread: ThreadSummary & ThreadRef,
    text: string,
    requestId: string,
    notify: readonly string[] | "everyone",
    requesterId: string | null,
    {
      machineIds = [],
      exposed = false,
    }: Partial<Pick<Task, "machineIds" | "exposed">> = {}
  ): Promise<string | null> {
    const conversation = await this.conversation(thread);
    await this.useCurrentAgent(thread.workspaceId, conversation);
    // The turn is the member's, so it uses their own integrations; one who left gets the workspace's only.
    const requester = this.members(thread.workspaceId).find(
      (member) => member.userId === requesterId
    );
    const task: Task = {
      requesterId: requester?.userId ?? null,
      requesterName: requester?.name ?? null,
      machineIds,
      exposed,
    };
    const submission = await conversation.submit(
      {
        type: "input",
        content: text,
        entry: { kind: TASK, data: task },
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
    const userIds =
      notify === "everyone"
        ? this.members(thread.workspaceId).map((member) => member.userId)
        : notify;
    for (const userId of userIds) {
      this.notifyAbout(thread, userId, answer.text);
    }
    return answer.text;
  }

  /**
   * The person whose latest request reached an agent, also through a thread relay or a task for them. A turn answers
   * the latest input, as later ones wait in the inbox, so this is the person of the running turn.
   */
  async requester(
    workspaceId: string,
    conversationId: ConversationId
  ): Promise<User | null> {
    const thread = this.threadOf(workspaceId, conversationId);
    const conversation = await this.conversation(thread);
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await conversation.entries(
        { order: "descending" },
        50,
        cursor,
        BACKGROUND_CONTEXT
      );
      const input = page.items.find(
        (entry) =>
          entry.kind === AUTHORED ||
          entry.kind === RELAYED ||
          entry.kind === TASK
      );
      if (input?.kind === TASK) {
        const task = input.data as unknown as Task;
        if (task.requesterId && task.requesterName) {
          const user = {
            id: task.requesterId,
            name: task.requesterName,
            email: "",
          };
          this.registry.requireMember(workspaceId, user);
          return user;
        }
        return null;
      }
      if (input?.kind === AUTHORED) {
        const { authorId, author } = input.data as unknown as Authored;
        const user = { id: authorId, name: author, email: "" };
        this.registry.requireMember(workspaceId, user);
        return user;
      }
      if (input?.kind === RELAYED) {
        const relay = input.data as unknown as Relay;
        if (relay.requesterId && relay.requesterName) {
          const user = {
            id: relay.requesterId,
            name: relay.requesterName,
            email: "",
          };
          this.registry.requireMember(workspaceId, user);
          return user;
        }
        return null;
      }
      cursor = page.next;
    } while (cursor);
    return null;
  }

  /**
   * Adds files to a channel of the person's workspace, or to the workspace's own files for a null `channelId`, without
   * a message; agents find them with list_files. Returns all files of that place.
   */
  async upload(
    workspaceId: string,
    channelId: string | null,
    user: User,
    files: readonly File[]
  ): Promise<SavedFile[]> {
    const place = this.place(workspaceId, channelId, user);
    if (files.length === 0) {
      throw new HttpError(400, "Choose a file");
    }
    await this.save(place, files);
    this.hooks.changed(workspaceId);
    return this.files(place);
  }

  /** A place of the person's workspace: a live channel, or the workspace itself for a null `channelId`. */
  place(workspaceId: string, channelId: string | null, user: User): FilePlace {
    if (channelId === null) {
      this.registry.requireMember(workspaceId, user);
      return { workspaceId, channelId };
    }
    this.registry.channel(workspaceId, channelId, user);
    return { workspaceId, channelId };
  }

  /** Where a thread keeps its files: its channel, or the workspace for the orchestrator. */
  placeOf(
    thread: Pick<ThreadRef, "id" | "workspaceId"> & {
      readonly channelId: string;
    }
  ): FilePlace {
    const orchestrator = this.registry.orchestratorOf(thread.workspaceId);
    return {
      workspaceId: thread.workspaceId,
      channelId: orchestrator?.id === thread.id ? null : thread.channelId,
    };
  }

  /** The files of a place, oldest first. */
  async files(place: FilePlace): Promise<SavedFile[]> {
    const directory = this.filesDirectory(place);
    const entries = await readdir(directory).catch(() => []);
    const files: SavedFile[] = [];
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

  /**
   * Deletes a file of the person's workspace; messages keep its name. Returns its place and the files left there.
   */
  async deleteFile(
    workspaceId: string,
    user: User,
    fileId: string
  ): Promise<{ readonly place: FilePlace; readonly files: SavedFile[] }> {
    const { path, place } = await this.file(workspaceId, user, fileId);
    // Nothing is removed: the file moves next to `files/`, where no listing or search looks.
    const deleted = join(dirname(dirname(path)), "deleted");
    await mkdir(deleted, { recursive: true });
    await rename(path, join(deleted, basename(path)));
    this.hooks.changed(workspaceId);
    return { place, files: await this.files(place) };
  }

  /** A file of the person's workspace, in any live channel or in the workspace's own files. */
  file(workspaceId: string, user: User, fileId: string) {
    this.registry.requireMember(workspaceId, user);
    return this.fileIn(workspaceId, fileId);
  }

  async messages(thread: ThreadRef): Promise<ThreadMessages> {
    const conversation = await this.conversation(thread);
    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    await watch.stop();
    return {
      ...threadMessages(
        watch.value,
        await earlierEntries(conversation, watch.value)
      ),
      approvals: this.approvalsIn(thread.id),
    };
  }

  /** Calls `listener` with the current messages, then after every change, until the returned stop is called. */
  async watch(
    thread: ThreadRef,
    listener: (messages: ThreadMessages) => void
  ): Promise<() => Promise<void>> {
    const conversation = await this.conversation(thread);
    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    // The entries before a compaction change only when the next compaction moves the head.
    let earlier: { head?: EntryId; entries: EntryRecord[] } = { entries: [] };
    let current = watch.value;
    const send = () =>
      listener({
        ...threadMessages(current, earlier.entries),
        approvals: this.approvalsIn(thread.id),
      });
    const show = async (view: ConversationView) => {
      const head = view.entries[0]?.head;
      if (head !== earlier.head) {
        earlier = { head, entries: await earlierEntries(conversation, view) };
      }
      current = view;
      send();
    };
    await show(watch.value);
    watch.start(show);
    const watchers = this.approvalWatchers.get(thread.id) ?? new Set();
    watchers.add(send);
    this.approvalWatchers.set(thread.id, watchers);
    return async () => {
      watchers.delete(send);
      await watch.stop();
    };
  }

  /**
   * Answers an approval of a thread of the person's workspace: `allow` runs the action, once or for the rest of the
   * turn on its machine. Only its approver answers, or any member when it has none.
   */
  answerApproval(
    threadId: string,
    approvalId: string,
    user: User,
    allow: boolean,
    scope: "once" | "turn"
  ): void {
    const thread = this.registry.thread(threadId, user);
    const pending = this.approvals.get(approvalId);
    if (pending?.threadId !== thread.id) {
      throw notFound();
    }
    const { approverId } = pending.approval;
    if (approverId && approverId !== user.id) {
      throw new HttpError(403, "Only the person it asks can answer");
    }
    pending.answer(allow, scope, user);
  }

  private approvalsIn(threadId: string): Approval[] {
    return [...this.approvals.values()]
      .filter((pending) => pending.threadId === threadId)
      .map((pending) => pending.approval);
  }

  private approvalsChanged(threadId: string): void {
    for (const send of this.approvalWatchers.get(threadId) ?? []) {
      send();
    }
  }

  /**
   * Stops the agent of a thread: it drops the messages it has not read yet and ends its run. The threads it asked for
   * something, and that still work on that message, stop too.
   */
  async stop(threadId: string, user: User): Promise<void> {
    const thread = this.registry.thread(threadId, user);
    const working = await this.workingNow(thread.workspaceId);
    await this.stopRun(thread, user, working, new Set());
  }

  private async stopRun(
    thread: ThreadSummary & ThreadRef,
    user: User,
    working: readonly string[],
    stopped: Set<string>
  ): Promise<void> {
    stopped.add(thread.id);
    if (!working.includes(thread.id)) {
      return;
    }
    const conversation = await this.conversation(thread);
    // When it stopped ends the agent's work in the transcript; the agent does not see it.
    await conversation.submit(
      {
        type: "write",
        entry: { kind: STOPPED, data: { at: Date.now(), by: user.id } },
      },
      BACKGROUND_CONTEXT
    );
    await conversation.abort(BACKGROUND_CONTEXT);
    for (const other of this.registry.threadsIn(thread.workspaceId)) {
      if (
        !stopped.has(other.id) &&
        working.includes(other.id) &&
        (await this.askedBy(other)) === thread.id
      ) {
        await this.stopRun(other, user, working, stopped);
      }
    }
  }

  /** The thread whose agent sent the message a thread works on, if another thread's agent sent it. */
  private async askedBy(thread: ThreadRef): Promise<string | undefined> {
    const input = await this.latestInput(await this.conversation(thread));
    return input?.kind === RELAYED
      ? (input.data as unknown as Relay).fromThreadId
      : undefined;
  }

  /** The newest message an agent works on: a person's, another thread's agent's, or work that no person typed. */
  private async latestInput(
    conversation: Conversation
  ): Promise<EntryRecord | undefined> {
    let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
    do {
      const page = await conversation.entries(
        { order: "descending" },
        50,
        cursor,
        BACKGROUND_CONTEXT
      );
      const input = page.items.find((entry) =>
        [AUTHORED, RELAYED, TASK].includes(entry.kind)
      );
      if (input) {
        return input;
      }
      cursor = page.next;
    } while (cursor);
    return undefined;
  }

  /**
   * Notifies the person whose message an agent answered, when its run ends. Work that no person typed notifies
   * through `instruct`. Work that another thread's agent gave notifies only a person who also writes in this thread,
   * such as in the orchestrator when a channel thread reports back to it.
   */
  private async notifyFinished(
    workspaceId: string,
    threadId: string
  ): Promise<void> {
    const thread = this.registry
      .threadsIn(workspaceId)
      .find((candidate) => candidate.id === threadId);
    if (!thread) {
      return;
    }
    const input = await this.latestInput(await this.conversation(thread));
    const userId = input && requesterIdOf(input);
    if (!(input && userId)) {
      return;
    }
    const { messages } = await this.messages(thread);
    const answer = messages.at(-1);
    if (
      answer?.agent &&
      answer.id !== String(input.id) &&
      !answer.streaming &&
      !answer.work?.stopped &&
      messages.some((message) => message.authorId === userId)
    ) {
      this.notifyAbout(thread, userId, answer.text);
    }
  }

  /** A notification that opens the thread. */
  private notifyAbout(
    thread: ThreadSummary & ThreadRef,
    userId: string,
    text: string
  ): void {
    this.notifications.notify({
      workspaceId: thread.workspaceId,
      userId,
      channelId: thread.channelId,
      threadId: thread.id,
      title: thread.title,
      text,
    });
  }

  /** The members of a workspace, for work that no person started. */
  private members(workspaceId: string) {
    return this.registry.members(
      workspaceId,
      this.registry.agentMember(workspaceId)
    );
  }

  /**
   * Calls `listener` with the ids of the threads of a workspace whose agent works, then after every change, until the
   * returned stop is called.
   */
  async watchWorking(
    workspaceId: string,
    user: User,
    listener: (threadIds: readonly string[]) => void
  ): Promise<() => Promise<void>> {
    this.registry.requireMember(workspaceId, user);
    const harness = await this.session(workspaceId);
    const watch = await harness.watchTaskGraph(BACKGROUND_CONTEXT);
    let last: string | undefined;
    const show = async (graph: TaskGraph) => {
      const threadIds = this.workingIn(workspaceId, graph);
      const key = threadIds.join();
      if (key !== last) {
        last = key;
        listener(threadIds);
      }
    };
    await show(watch.value);
    watch.start(show);
    return async () => {
      await watch.stop();
    };
  }

  private async workingNow(workspaceId: string): Promise<string[]> {
    const watch = await (await this.session(workspaceId)).watchTaskGraph(
      BACKGROUND_CONTEXT
    );
    const threadIds = this.workingIn(workspaceId, watch.value);
    await watch.stop();
    return threadIds;
  }

  /** The threads of a workspace with a live task that is not background work. */
  private workingIn(workspaceId: string, graph: TaskGraph): string[] {
    const busy = new Set(
      Object.values(graph.tasks)
        .filter((task) => !task.background)
        .map((task) => String(task.conversationId))
    );
    return this.registry
      .threadsIn(workspaceId)
      .filter((thread) => busy.has(String(thread.conversationId)))
      .map((thread) => thread.id);
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

  /** The newest brief of a channel of the person's workspace; `null` before its first. */
  async brief(
    workspaceId: string,
    channelId: string,
    user: User
  ): Promise<Brief | null> {
    this.registry.channel(workspaceId, channelId, user);
    await this.session(workspaceId);
    return this.briefs.get(workspaceId)!.latest(channelId);
  }

  async closeAll(): Promise<void> {
    this.background.abort();
    for (const timer of [...this.catchUpTimers.values(), ...this.briefChecks]) {
      clearTimeout(timer);
    }
    await Promise.allSettled(this.catchingUp.values());
    const sessions = await Promise.allSettled(this.open.values());
    this.open.clear();
    for (const memory of this.memories.values()) {
      memory.close();
    }
    this.memories.clear();
    for (const briefs of this.briefs.values()) {
      briefs.close();
    }
    this.briefs.clear();
    await this.sandbox.close();
    for (const session of sessions) {
      if (session.status === "fulfilled") {
        await session.value.close(BACKGROUND_CONTEXT);
      }
    }
  }

  /** The path, name, and place of a file of the workspace; ids are UUIDv7, so one id names one file. */
  private async fileIn(
    workspaceId: string,
    fileId: string
  ): Promise<{
    readonly path: string;
    readonly name: string;
    readonly place: FilePlace;
  }> {
    const places: FilePlace[] = [
      { workspaceId, channelId: null },
      ...this.registry
        .channelsIn(workspaceId)
        .map((channel) => ({ workspaceId, channelId: channel.id })),
    ];
    for (const place of places) {
      const file = (await this.files(place)).find(
        (candidate) => candidate.id === fileId
      );
      if (file) {
        return {
          path: join(this.filesDirectory(place), `${file.id}-${file.name}`),
          name: file.name,
          place,
        };
      }
    }
    throw notFound();
  }

  private async save(
    place: FilePlace,
    files: readonly File[]
  ): Promise<FileRef[]> {
    if (files.length === 0) {
      return [];
    }
    const directory = this.filesDirectory(place);
    await mkdir(directory, { recursive: true });
    const saved: FileRef[] = [];
    for (const file of files) {
      const ref = { id: Bun.randomUUIDv7(), name: fileName(file.name) };
      await Bun.write(join(directory, `${ref.id}-${ref.name}`), file);
      saved.push(ref);
    }
    return saved;
  }

  /**
   * Saves one file that `write` writes to the path it gets, and returns the file's name. Listings leave the file out
   * until it is whole.
   */
  private async keep(
    place: FilePlace,
    write: (path: string) => Promise<string>
  ): Promise<FileRef> {
    const directory = this.filesDirectory(place);
    await mkdir(directory, { recursive: true });
    const id = Bun.randomUUIDv7();
    const partial = join(directory, `.${id}.partial`);
    try {
      const name = fileName(await write(partial));
      await rename(partial, join(directory, `${id}-${name}`));
      return { id, name };
    } catch (error) {
      // Never a file of the place: only what a failed save wrote of it.
      await rm(partial, { force: true });
      throw error;
    }
  }

  private filesDirectory(place: FilePlace): string {
    const workspace = join(this.dataDirectory, "workspaces", place.workspaceId);
    return place.channelId === null
      ? join(workspace, "files")
      : join(workspace, "channels", place.channelId, "files");
  }

  private async deliver(
    workspaceId: string,
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
    await this.useCurrentAgent(workspaceId, conversation);
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

  private async makeOrchestrator(
    workspaceId: string
  ): Promise<ThreadSummary & ThreadRef> {
    const [channel] = this.registry.channelsIn(workspaceId);
    if (!channel) {
      throw notFound();
    }
    const harness = await this.session(workspaceId);
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: this.currentModel(),
          thinkingLevel: this.llm.effort(),
          instructions: `${INSTRUCTIONS} ${ORCHESTRATOR}`,
          extensions: { add: [this.memories.get(workspaceId)!.extension] },
        },
      },
      BACKGROUND_CONTEXT
    );
    const thread = {
      ...this.registry.registerThread(workspaceId, {
        id: randomUUID(),
        channelId: channel.id,
        title: "Golem",
        conversationId: conversation.id,
        createdBy: "golem",
        orchestrator: true,
      }),
      workspaceId,
      conversationId: conversation.id,
    };
    return thread;
  }

  /** Takes the workspace's new messages into its memory and its briefs, a moment after the last change. */
  private catchUp(workspaceId: string): void {
    if (this.background.signal.aborted) {
      return;
    }
    clearTimeout(this.catchUpTimers.get(workspaceId));
    this.catchUpTimers.set(
      workspaceId,
      setTimeout(() => {
        const next = (this.catchingUp.get(workspaceId) ?? Promise.resolve())
          .then(() => this.catchUpNow(workspaceId))
          .catch((error) => {
            if (!this.background.signal.aborted) {
              console.error(`Catching up ${workspaceId} failed`, error);
            }
          });
        this.catchingUp.set(workspaceId, next);
      }, CATCH_UP_MS)
    );
  }

  /**
   * Adds the finished messages of each thread that changed to the memory, and, once the thread stops running, notes
   * the ones that its channel's brief has not read. After the orchestrator's turn, it compacts the orchestrator when
   * its context is long.
   */
  private async catchUpNow(workspaceId: string): Promise<void> {
    const memory = this.memories.get(workspaceId);
    const briefs = this.briefs.get(workspaceId);
    if (!(memory && briefs)) {
      return;
    }
    const orchestrator = this.registry.orchestratorOf(workspaceId);
    const said: Said[] = [];
    let orchestratorAnswered = false;
    for (const thread of this.registry.threadsIn(workspaceId)) {
      if (this.background.signal.aborted) {
        return;
      }
      const version = await this.version(thread);
      if (this.caughtUp.get(thread.id) === version) {
        continue;
      }
      const { messages, running } = await this.messages(thread);
      said.push(...this.saidIn(workspaceId, thread, messages));
      if (running) {
        continue;
      }
      if (thread.id === orchestrator?.id) {
        orchestratorAnswered = true;
      } else {
        const through = briefs.through(thread.id);
        const fresh = messages.filter(
          (message) => Number(message.id) > through
        );
        if (fresh.length > 0) {
          const waiting = this.unbriefed.get(thread.channelId) ?? new Map();
          waiting.set(thread.id, fresh.at(-1)!.time);
          this.unbriefed.set(thread.channelId, waiting);
        }
      }
      this.caughtUp.set(thread.id, version);
    }
    memory.add(said);
    if (orchestratorAnswered && orchestrator) {
      await this.compactWhenLong(
        workspaceId,
        await this.session(workspaceId),
        await this.conversation(orchestrator),
        memory
      );
    }
    this.briefWhenQuiet(workspaceId, briefs);
  }

  /** Adds the orchestrator's finished messages to the memory now, for a compaction in the middle of its turn. */
  private async rememberOrchestrator(workspaceId: string): Promise<void> {
    const orchestrator = this.registry.orchestratorOf(workspaceId);
    if (orchestrator) {
      const { messages } = await this.messages(orchestrator);
      this.memories
        .get(workspaceId)
        ?.add(this.saidIn(workspaceId, orchestrator, messages));
    }
  }

  /**
   * The messages of a thread as the memory reads them, up to an answer that the agent still writes; a message of a
   * thread other than the orchestrator starts with the thread's link.
   */
  private saidIn(
    workspaceId: string,
    thread: ThreadSummary & ThreadRef,
    messages: readonly Message[]
  ): Said[] {
    const writing = messages.findIndex((message) => message.streaming);
    const where =
      thread.id === this.registry.orchestratorOf(workspaceId)?.id
        ? ""
        : `${threadLink(thread)} `;
    return messages
      .slice(0, writing === -1 ? undefined : writing)
      .map((message) => ({
        threadId: thread.id,
        messageId: Number(message.id),
        text: `${where}${minute(message.time)} UTC ${saidText(message)}`,
      }));
  }

  /** Starts the brief of each channel whose threads with new messages are all quiet or settled. */
  private briefWhenQuiet(workspaceId: string, briefs: Briefs): void {
    const now = Date.now();
    for (const channel of this.registry.channelsIn(workspaceId)) {
      const waiting = this.unbriefed.get(channel.id);
      if (!waiting?.size || this.briefing.has(channel.id)) {
        continue;
      }
      const quiet = [...waiting].every(
        ([threadId, newest]) =>
          now - newest >= BRIEF_QUIET_MS ||
          Boolean(
            channel.threads.find((thread) => thread.id === threadId)?.settledAt
          )
      );
      if (quiet) {
        this.briefing.add(channel.id);
        this.writeBrief(workspaceId, channel, briefs, new Map(waiting))
          .catch((error) => {
            if (!this.background.signal.aborted) {
              console.error(`The brief of #${channel.name} failed`, error);
            }
          })
          .finally(() => this.briefing.delete(channel.id));
      }
    }
  }

  /**
   * Writes the channel's brief again from the new messages of its `waiting` threads, and its summary with it. A thread
   * that runs again waits for the next brief, and so does one that got a message while the model wrote.
   */
  private async writeBrief(
    workspaceId: string,
    channel: Channel,
    briefs: Briefs,
    waiting: ReadonlyMap<string, number>
  ): Promise<void> {
    const messages: BriefMessage[] = [];
    const read: string[] = [];
    for (const thread of this.registry.threadsIn(workspaceId)) {
      if (!waiting.has(thread.id)) {
        continue;
      }
      const state = await this.messages(thread);
      if (state.running) {
        continue;
      }
      const through = briefs.through(thread.id);
      for (const message of state.messages) {
        if (Number(message.id) > through) {
          messages.push({
            threadId: thread.id,
            threadTitle: thread.title,
            messageId: Number(message.id),
            author: message.author,
            text: messageBody(message),
            time: message.time,
          });
        }
      }
      read.push(thread.id);
    }
    if (messages.length > 0) {
      const summary = await briefs.merge(
        channel,
        messages.sort((a, b) => a.messageId - b.messageId),
        this.background.signal
      );
      if (summary) {
        this.registry.setChannelSummary(workspaceId, channel.id, summary);
      }
    }
    const left = this.unbriefed.get(channel.id);
    for (const threadId of read) {
      if (left?.get(threadId) === waiting.get(threadId)) {
        left?.delete(threadId);
      }
    }
  }

  /**
   * The channel section of the instructions of a thread in a channel: the channel's brief and its threads, newest
   * first. It changes only when they do, so it keeps the prompt cache.
   */
  private channelSection(workspaceId: string) {
    return section("channel", ({ conversationId }) => {
      const thread = this.registry
        .threadsIn(workspaceId)
        .find((candidate) => candidate.conversationId === conversationId);
      const channel = this.registry
        .channelsIn(workspaceId)
        .find((candidate) => candidate.id === thread?.channelId);
      if (
        !(thread && channel) ||
        thread.id === this.registry.orchestratorOf(workspaceId)?.id
      ) {
        return;
      }
      const brief = this.briefs.get(workspaceId)?.latest(channel.id);
      // Without this thread, which moves to the top at each of its messages and would change the section each time.
      const others = channel.threads.filter(
        (candidate) => candidate.id !== thread.id
      );
      const listed = others
        .slice(0, LISTED_THREADS)
        .map(
          (candidate) =>
            `- ${threadLink(candidate)}: ${candidate.settledAt === null ? "open" : "settled"}, last message from a person ${minute(candidate.updatedAt)} UTC`
        );
      const older = others.length - listed.length;
      return [
        `This thread is in #${channel.name}.`,
        `The brief of #${channel.name}:\n${brief?.text ?? "No brief yet."}`,
        listed.length
          ? `The other threads of #${channel.name}, newest first:\n${listed.join("\n")}${older > 0 ? `\n- and ${older} older threads` : ""}`
          : `#${channel.name} has no other threads.`,
      ].join("\n\n");
    });
  }

  private async compactWhenLong(
    workspaceId: string,
    harness: Harness,
    conversation: Conversation,
    memory: Memory
  ): Promise<void> {
    const count = memory.count();
    if (count - (this.compacted.get(workspaceId) ?? 0) < COMPACTION_MESSAGES) {
      return;
    }
    const { messages } = await conversation.context(BACKGROUND_CONTEXT);
    if (JSON.stringify(messages).length / 4 < ORCHESTRATOR_TOKENS) {
      return;
    }
    this.compacted.set(workspaceId, count);
    const task = await conversation.compact(undefined, BACKGROUND_CONTEXT);
    const { outcome } = (await harness.waitForTask(task, BACKGROUND_CONTEXT))
      .state;
    if (outcome.status === "completed" && outcome.result.submissionId) {
      const placed = await harness.submission(
        outcome.result.submissionId,
        BACKGROUND_CONTEXT
      );
      await placed?.wait(BACKGROUND_CONTEXT);
    }
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
    // The storage makes the workspace's folder, which the memory is in.
    const storage = await openNodeSqliteStorage(path);
    const memoryPath = join(
      this.dataDirectory,
      "workspaces",
      workspaceId,
      "memory.sqlite"
    );
    const summarize = (
      systemPrompt: string,
      text: string,
      signal: AbortSignal
    ) => this.llm.complete(systemPrompt, text, signal);
    const memory = new Memory(
      memoryPath,
      (threadId, messageId) => this.said(workspaceId, threadId, messageId),
      summarize,
      () => this.rememberOrchestrator(workspaceId)
    );
    this.memories.set(workspaceId, memory);
    this.forget(workspaceId);
    this.briefs.set(workspaceId, new Briefs(memoryPath, summarize));
    const golem = await this.golemExtension(workspaceId);
    const extension = createCodemodeExtension({
      sandbox: this.sandbox,
      namespaces: [...NAMESPACES, ...this.integrations.namespaces()],
    });
    const codemode = {
      ...extension,
      tools: extension.tools?.map((tool) =>
        tool.name === "codemode" ? withDeadline(tool) : tool
      ),
    };
    const registry = createRegistry();
    this.registries.set(workspaceId, registry);
    registry.install(golem);
    registry.install(codemode);
    registry.install(memory.extension);
    // Only the orchestrator selects the memory.
    const harness = await Harness.open(
      storage,
      {
        models: this.llm.models,
        registry,
        settings: { extensions: [golem, codemode] },
      },
      BACKGROUND_CONTEXT
    ).catch((error) => {
      memory.close();
      throw error;
    });
    const changes = await harness.watchTaskGraph(BACKGROUND_CONTEXT);
    let working = this.workingIn(workspaceId, changes.value);
    changes.start(async (graph) => {
      this.hooks.changed(workspaceId);
      this.catchUp(workspaceId);
      const now = this.workingIn(workspaceId, graph);
      for (const threadId of working.filter((id) => !now.includes(id))) {
        this.notifyFinished(workspaceId, threadId).catch((error: unknown) =>
          console.error("notifying a finished run failed", error)
        );
      }
      working = now;
    });
    // Continue runs that a previous process left unfinished.
    harness.resume();
    // Messages that came while Golem was off, and briefs whose threads went quiet without a change.
    this.catchUp(workspaceId);
    this.briefChecks.push(
      setInterval(() => this.catchUp(workspaceId), BRIEF_CHECK_MS)
    );
    return harness;
  }

  /**
   * Golem's tools for one workspace. The model calls the core tools itself; the others it calls from codemode scripts,
   * which find them by namespace, so the model's own tools stay few however many integrations a workspace has.
   */
  private async golemExtension(workspaceId: string) {
    const [connectors, hooked] = await Promise.all([
      this.integrations.tools(workspaceId),
      this.hooks.tools(workspaceId),
    ]);
    const requesterOf = async (conversationId: ConversationId) =>
      (await this.requester(workspaceId, conversationId))?.id ?? null;
    const tools = [
      this.recallTool(workspaceId),
      this.listChannelsTool(workspaceId),
      this.searchChannelsTool(workspaceId),
      this.createChannelTool(workspaceId),
      this.deleteChannelTool(workspaceId),
      this.readThreadTool(workspaceId),
      this.startThreadTool(workspaceId),
      this.sendToThreadTool(workspaceId),
      this.notifyTool(workspaceId),
      this.listFilesTool(workspaceId),
      this.readFileTool(workspaceId),
      this.saveFileTool(workspaceId),
      ...this.llm.tools(),
      ...[
        this.copyToMachineTool(workspaceId, requesterOf),
        ...this.hands.tools(workspaceId, requesterOf),
        ...connectors.map((tool) =>
          this.exposing(workspaceId, connectorTool(tool, requesterOf))
        ),
        ...this.artifacts.tools(workspaceId),
        ...this.browser.tools(workspaceId, requesterOf),
        ...hooked,
      ].map(scriptOnly),
    ].map((tool: ToolRegistration) => {
      if (EXPOSING.has(tool.name)) {
        return this.exposing(workspaceId, tool);
      }
      return CHANGES_MACHINE.has(tool.name)
        ? this.approved(workspaceId, tool)
        : tool;
    });
    return defineExtension({
      name: "golem",
      tools,
      sections: [
        this.hands.section(workspaceId, requesterOf),
        this.channelSection(workspaceId),
      ],
    });
  }

  /** Gives the new runs of an open workspace its connectors' current tools, such as after someone connects one. */
  async reloadTools(workspaceId: string): Promise<void> {
    const registry = this.registries.get(workspaceId);
    registry?.install(await this.golemExtension(workspaceId));
  }

  /**
   * Takes the messages of threads that are gone, such as those of a deleted channel, out of the workspace's memory,
   * when it is open; it also does so when it opens.
   */
  forget(workspaceId: string): void {
    this.memories
      .get(workspaceId)
      ?.keep(
        new Set(this.registry.threadsIn(workspaceId).map((thread) => thread.id))
      );
  }

  /** A tool whose result comes from outside the workspace's members: its call marks the turn as exposed. */
  private exposing(workspaceId: string, tool: ToolRegistration) {
    return {
      ...tool,
      execute: async (
        ...[args, api, context]: Parameters<ToolRegistration["execute"]>
      ) => {
        await this.expose(workspaceId, api.conversationId);
        return tool.execute(args, api, context);
      },
    };
  }

  /** Marks the running turn of a conversation as exposed, in its transcript, so a rerun after a restart sees it too. */
  private async expose(
    workspaceId: string,
    conversationId: ConversationId
  ): Promise<void> {
    const conversation = await this.conversation(
      this.threadOf(workspaceId, conversationId)
    );
    await conversation.submit(
      { type: "write", entry: { kind: EXPOSED, data: { at: Date.now() } } },
      BACKGROUND_CONTEXT
    );
  }

  /**
   * A tool that changes a machine, which waits for a person to allow it when the turn took in content that no member
   * wrote, when no person watches the turn, or when another person paired the machine and does not trust the turn's
   * person. A command that only reads never waits. An allowed call keeps its memo, so a rerun after a restart does not
   * ask again.
   */
  private approved(workspaceId: string, tool: ToolRegistration) {
    return {
      ...tool,
      execute: async (
        ...[args, api, context]: Parameters<ToolRegistration["execute"]>
      ) => {
        const { machine, command } = args as {
          machine: string;
          command?: string;
        };
        if (
          !(
            (command !== undefined && readOnlyCommand(command)) ||
            (await api.memo<boolean>("approved", context))
          )
        ) {
          const requesterId =
            (await this.requester(workspaceId, api.conversationId))?.id ?? null;
          const found = this.hands.machineNamed(
            workspaceId,
            requesterId,
            machine
          );
          await this.allowed(
            workspaceId,
            api.conversationId,
            requesterId,
            tool.name,
            actionText(tool.name, args as Record<string, unknown>, found.name),
            found,
            context.abortSignal
          );
          await api.memo("approved", true, context);
        }
        return tool.execute(args, api, context);
      },
    };
  }

  /**
   * Lets the runs of a routine change machines without asking, which nobody watches: at once when the person writes it
   * in a turn they started that read nothing from outside, else once its approver allows it, as for a change on each
   * machine. Returns the machines' ids; throws when nobody allows one.
   */
  async allowRuns(
    workspaceId: string,
    conversationId: ConversationId,
    routine: string,
    machines: readonly string[],
    signal: AbortSignal | undefined
  ): Promise<string[]> {
    const requesterId =
      (await this.requester(workspaceId, conversationId))?.id ?? null;
    const ids: string[] = [];
    for (const name of new Set(machines)) {
      const machine = this.hands.machineNamed(workspaceId, requesterId, name);
      await this.allowed(
        workspaceId,
        conversationId,
        requesterId,
        "routines",
        `Let routine ${routine} change ${machine.name} in each run`,
        machine,
        signal,
        true
      );
      ids.push(machine.id);
    }
    return ids;
  }

  /**
   * Resolves when the action may run: at once, or once its approver allows it; throws when nobody does. A `standing`
   * action lasts beyond the turn, so an "allow for this turn" neither covers it nor comes from it.
   */
  private async allowed(
    workspaceId: string,
    conversationId: ConversationId,
    requesterId: string | null,
    tool: string,
    text: string,
    machine: Pick<Machine, "id" | "pairedBy" | "trustedMemberIds">,
    signal: AbortSignal | undefined,
    standing = false
  ): Promise<void> {
    const thread = this.threadOf(workspaceId, conversationId);
    const conversation = await this.conversation(thread);
    const turn = await turnOf(conversation);
    if (!standing && turn.allowed.has(machine.id)) {
      return;
    }
    const members = this.members(workspaceId).map((member) => member.userId);
    // The machine's owner allows every change for another person; one who left the workspace owns nothing.
    const owner =
      machine.pairedBy && members.includes(machine.pairedBy)
        ? machine.pairedBy
        : null;
    // A routine's run on a machine that its person allowed when they wrote it is as if they watched it.
    const granted = turn.granted.has(machine.id);
    const trusted =
      granted ||
      (requesterId !== null && machine.trustedMemberIds.includes(requesterId));
    let approverId: string | null;
    if (owner && owner !== requesterId && !trusted) {
      approverId = owner;
    } else if (turn.exposed || (turn.unattended && !granted)) {
      approverId = requesterId ?? owner;
    } else {
      return;
    }
    const scope = await this.ask(
      thread,
      approverId,
      members,
      tool,
      text,
      signal
    );
    if (scope === "turn" && !standing) {
      await conversation.submit(
        {
          type: "write",
          entry: { kind: ALLOWED, data: { machineId: machine.id } },
        },
        BACKGROUND_CONTEXT
      );
    }
  }

  /**
   * Shows an approval in the thread and notifies its approver, or every member for none, and waits up to
   * `APPROVAL_WAIT` for an answer. Deny, the wait's end, and Stop throw, so the agent gets an error result.
   */
  private ask(
    thread: ThreadSummary & ThreadRef,
    approverId: string | null,
    members: readonly string[],
    tool: string,
    text: string,
    signal: AbortSignal | undefined
  ): Promise<"once" | "turn"> {
    const approval: Approval = {
      id: randomUUID(),
      tool,
      text,
      approverId,
      expiresAt: Date.now() + APPROVAL_WAIT,
    };
    return new Promise((resolve, reject) => {
      const end = (outcome: Error | "once" | "turn") => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stopped);
        this.approvals.delete(approval.id);
        this.approvalsChanged(thread.id);
        if (outcome instanceof Error) {
          reject(outcome);
        } else {
          resolve(outcome);
        }
      };
      const stopped = () => end(new Error("Someone stopped the agent."));
      const timer = setTimeout(
        () => end(new Error("Nobody allowed this in 10 minutes.")),
        APPROVAL_WAIT
      );
      signal?.addEventListener("abort", stopped, { once: true });
      this.approvals.set(approval.id, {
        approval,
        threadId: thread.id,
        answer: (allow, scope, by) =>
          end(allow ? scope : new Error(`${by.name} did not allow this.`)),
      });
      this.approvalsChanged(thread.id);
      for (const userId of approverId ? [approverId] : members) {
        this.notifyAbout(thread, userId, `Allow? ${text}`);
      }
      if (signal?.aborted) {
        stopped();
      }
    });
  }

  /** One message of a thread whole, for zoom in the workspace's memory. */
  private async said(
    workspaceId: string,
    threadId: string,
    messageId: number
  ): Promise<{ text: string; time: number } | undefined> {
    const thread = this.registry
      .threadsIn(workspaceId)
      .find((candidate) => candidate.id === threadId);
    if (!thread) {
      return undefined;
    }
    const { messages } = await this.messages(thread);
    const index = messages.findIndex(
      (candidate) => Number(candidate.id) === messageId
    );
    const said = this.saidIn(workspaceId, thread, messages)[index];
    return said && { text: said.text, time: messages[index]!.time };
  }

  /** Lets the agent search its own workspace: threads, notes, files, and captures. */
  private recallTool(workspaceId: string) {
    return defineTool({
      name: "recall",
      description:
        "Search everything in this workspace: earlier threads, artifacts, notes, files, and captured mail or chats. Use it to recall facts, decisions, and what people said.",
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
                return `${number + 1}. [${result.kind}] ${result.title} (${day(result.updatedAt)}${recalledId(result.uri)}${where}): ${result.snippet}`;
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
        "List the channels of this workspace with their summaries, newest threads, and thread ids.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        const text = this.registry
          .channelsIn(workspaceId)
          .map(channelText)
          .join("\n");
        return { output: [{ type: "text", text }] };
      },
    });
  }

  private searchChannelsTool(workspaceId: string) {
    return defineTool({
      name: "search_channels",
      description:
        "Find the channels of this workspace whose name, summary, or thread titles have the words of a query, best match first.",
      parameters: Type.Object({
        query: Type.String({ description: "Words to look for" }),
      }),
      replay: "safe",
      execute: async (args) => {
        const words = args.query.toLowerCase().split(/\W+/).filter(Boolean);
        const text =
          this.registry
            .channelsIn(workspaceId)
            .map((channel) => {
              const haystack = [
                channel.name,
                channel.summary ?? "",
                ...channel.threads.map((thread) => thread.title),
              ]
                .join(" ")
                .toLowerCase();
              const score = words.filter((word) =>
                haystack.includes(word)
              ).length;
              return { channel, score };
            })
            .filter(({ score }) => score > 0)
            .sort((left, right) => right.score - left.score)
            .map(({ channel }) => channelText(channel))
            .join("\n") || "No channel matches. list_channels shows them all.";
        return { output: [{ type: "text", text }] };
      },
    });
  }

  private createChannelTool(workspaceId: string) {
    return defineTool({
      name: "create_channel",
      description:
        "Create a channel in this workspace, for a topic that needs its own threads, with a short summary of what it is for.",
      parameters: Type.Object({
        name: Type.String({
          description: "Lowercase words joined by dashes, such as trips",
        }),
        summary: Type.Optional(Type.String({ maxLength: 2000 })),
      }),
      execute: async (args) => {
        const channel = this.registry.addChannel(
          workspaceId,
          args.name,
          "golem"
        );
        if (args.summary) {
          this.registry.setChannelSummary(
            workspaceId,
            channel.id,
            args.summary
          );
        }
        this.hooks.changed(workspaceId);
        return {
          output: [{ type: "text", text: `Created #${channel.name}.` }],
        };
      },
    });
  }

  private deleteChannelTool(workspaceId: string) {
    return defineTool({
      name: "delete_channel",
      description:
        "Delete a channel of this workspace, with its threads and routines. Delete only when the family asks for it.",
      parameters: Type.Object({
        channel: Type.String({ description: "The channel name" }),
      }),
      execute: async (args) => {
        const name = args.channel.replace(/^#/, "").toLowerCase();
        const channel = this.registry
          .channelsIn(workspaceId)
          .find((candidate) => candidate.name === name);
        if (!channel) {
          throw new Error(
            `There is no channel #${name}. list_channels shows the channels.`
          );
        }
        try {
          this.registry.removeChannel(workspaceId, channel.id);
        } catch (error) {
          throw new Error(`#${name} stays: ${(error as Error).message}.`, {
            cause: error,
          });
        }
        this.hooks.changed(workspaceId);
        return { output: [{ type: "text", text: `Deleted #${name}.` }] };
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
            .map(
              (message) =>
                `${minute(message.time)} UTC ${message.author}: ${message.text}`
            )
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
        const requester = await this.requester(workspaceId, api.conversationId);
        const turn = await turnOf(await this.conversation(from));
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
          workspaceId,
          await this.conversation(thread),
          relayed(
            from,
            args.message,
            hops,
            `relay:${api.taskId}`,
            requester,
            turn.exposed || turn.unattended
          )
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
        const requester = await this.requester(workspaceId, api.conversationId);
        const turn = await turnOf(await this.conversation(from));
        const target = this.threadIn(workspaceId, args.thread);
        if (target.id === from.id) {
          throw new Error("That is this thread. Answer here instead.");
        }
        await this.deliver(
          workspaceId,
          await this.conversation(target),
          relayed(
            from,
            args.message,
            hops,
            `relay:${api.taskId}`,
            requester,
            turn.exposed || turn.unattended
          )
        );
        this.registry.touchThread(target.id);
        return {
          output: [{ type: "text", text: `Sent to ${threadLink(target)}.` }],
        };
      },
    });
  }

  private notifyTool(workspaceId: string) {
    return defineTool({
      name: "notify",
      description:
        "Notify people of this workspace about something that needs their attention and that nobody waits for, such as what you found in work nobody asked for now. It goes to their inbox and their phone, and opens this thread or its channel. Do not notify about your answer to a person's message, or about the answer of a routine or a reminder: those notify already.",
      parameters: Type.Object({
        text: Type.String({
          description: "What needs attention, in one or two sentences",
        }),
        to: Type.Optional(
          Type.Array(
            Type.String({ description: "Name of a member of this workspace" }),
            {
              description:
                "Without it: the person who asked in this thread, or else every member",
            }
          )
        ),
        open: Type.Optional(
          Type.Union([Type.Literal("thread"), Type.Literal("channel")], {
            description: "What the notification opens; thread by default",
          })
        ),
      }),
      execute: async (args, api) => {
        const thread = this.threadOf(workspaceId, api.conversationId);
        const members = this.members(workspaceId);
        const requester = await this.requester(workspaceId, api.conversationId);
        const recipients = args.to?.length
          ? args.to.map((name) => {
              const member = members.find(
                (candidate) =>
                  candidate.name.toLowerCase() === name.trim().toLowerCase()
              );
              if (!member) {
                throw new Error(
                  `Nobody named ${name} is a member. Members: ${members.map((candidate) => candidate.name).join(", ")}.`
                );
              }
              return member;
            })
          : members.filter(
              (member) => !requester || member.userId === requester.id
            );
        for (const member of recipients) {
          this.notifications.notify({
            workspaceId,
            userId: member.userId,
            channelId: thread.channelId,
            threadId: args.open === "channel" ? null : thread.id,
            title: thread.title,
            text: args.text,
          });
        }
        return {
          output: [
            {
              type: "text",
              text: `Notified ${recipients.map((member) => member.name).join(", ")}.`,
            },
          ],
        };
      },
    });
  }

  private listFilesTool(workspaceId: string) {
    return defineTool({
      name: "list_files",
      description:
        "List the files of this thread's channel: uploaded to the channel, or attached to messages in any of its threads. In the orchestrator, the workspace's own files.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api) => {
        const files = await this.files(
          this.placeOf(this.threadOf(workspaceId, api.conversationId))
        );
        const text =
          files
            .map(
              (file) =>
                `- ${file.name} (file ${file.id}, ${Math.ceil(file.size / 1024)} KB, ${day(file.time)})`
            )
            .join("\n") || "There are no files here.";
        return { output: [{ type: "text", text }] };
      },
    });
  }

  private readFileTool(workspaceId: string) {
    return defineTool({
      name: "read_file",
      description:
        "Read a file of this workspace by its id, from list_files or recall: the text of a document, sheet, slides, or PDF, or a picture.",
      parameters: Type.Object({
        file: Type.String({ description: "The file id" }),
      }),
      replay: "safe",
      execute: async (args) => {
        const { path, name } = await this.fileIn(workspaceId, args.file).catch(
          () => {
            throw new Error(
              `There is no file ${args.file} in this workspace. list_files and recall show files.`
            );
          }
        );
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

  /** Lets the agent show people a picture or file it made, such as a screenshot of a machine or of its browser. */
  private saveFileTool(workspaceId: string) {
    return defineTool({
      name: "save_file",
      description:
        "Save a file to this thread's channel, so people can open it and you can show it in your answer: text you write (content and name), a PDF of an artifact's page (artifact), a file of a machine up to 1 GB (machine and path, such as a screenshot you took there with hands_exec), a screenshot of this thread's browser (browser_screenshot), or a file from the web up to 100 MB (url). Returns the file id. Show a picture with ![what it shows](file:<id>); link another file with [name](file:<id>).",
      parameters: Type.Object({
        content: Type.Optional(
          Type.String({
            description:
              "The text of the file, such as Markdown that starts with `# <title>`, CSV, or an iCalendar event",
          })
        ),
        artifact: Type.Optional(
          Type.String({
            description:
              "An artifact id; its page is printed on the paper size of its CSS @page rule",
          })
        ),
        machine: Type.Optional(Type.String({ description: "Machine name" })),
        path: Type.Optional(
          Type.String({ description: "File path on the machine" })
        ),
        browser_screenshot: Type.Optional(
          Type.Boolean({ description: "Save the page the browser shows" })
        ),
        url: Type.Optional(
          Type.String({ description: "An http or https address to download" })
        ),
        name: Type.Optional(
          Type.String({ description: "The file name people see" })
        ),
      }),
      execute: async (args, api, context) => {
        const place = this.placeOf(
          this.threadOf(workspaceId, api.conversationId)
        );
        const saved = await this.keep(place, (path) =>
          this.saveFrom(
            workspaceId,
            api.conversationId,
            args,
            path,
            context.abortSignal
          )
        );
        this.hooks.changed(workspaceId);
        return {
          output: [
            {
              type: "text",
              text: `Saved ${saved.name} as file ${saved.id}.`,
            },
          ],
        };
      },
    });
  }

  /** Writes the file that save_file's arguments name to `path`; returns the name people see. */
  private async saveFrom(
    workspaceId: string,
    conversationId: ConversationId,
    args: SaveSource,
    path: string,
    signal: AbortSignal | undefined
  ): Promise<string> {
    if (args.content !== undefined) {
      if (!args.name) {
        throw new Error("Give the file a name with its extension.");
      }
      await Bun.write(path, args.content);
      return args.name;
    }
    if (args.artifact) {
      const title = await this.printArtifact(workspaceId, args.artifact, path);
      return args.name || `${title}.pdf`;
    }
    if (args.browser_screenshot) {
      const screenshot = await this.browser.screenshot(
        workspaceId,
        conversationId,
        (await this.requester(workspaceId, conversationId))?.id ?? null
      );
      if (!screenshot) {
        throw new Error("The browser could not take a screenshot.");
      }
      await Bun.write(path, screenshot);
      return args.name || "screenshot.png";
    }
    if (args.machine && args.path) {
      await this.hands.file(
        workspaceId,
        (await this.requester(workspaceId, conversationId))?.id ?? null,
        args.machine,
        args.path,
        path,
        MAX_MACHINE_FILE
      );
      return args.name || basename(args.path);
    }
    if (args.url) {
      await this.expose(workspaceId, conversationId);
      const name = await this.browser.download(args.url, path, signal);
      return args.name || name;
    }
    throw new Error(
      "Give content and name, artifact, machine and path, browser_screenshot, or url."
    );
  }

  /** Writes a PDF of an artifact of the workspace to `path`; returns the artifact's title. */
  private async printArtifact(
    workspaceId: string,
    artifactId: string,
    path: string
  ): Promise<string> {
    const artifact = this.artifacts
      .inWorkspace(workspaceId)
      .find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(
        `There is no artifact ${artifactId} in this workspace. artifacts_list shows them.`
      );
    }
    await Bun.write(
      path,
      await this.browser.pdf(this.artifacts.content(artifact.id))
    );
    return artifact.title;
  }

  /** Lets the agent work on a file of the workspace on a machine, such as to convert it or fill in a form. */
  private copyToMachineTool(
    workspaceId: string,
    requesterOf: (conversationId: ConversationId) => Promise<string | null>
  ) {
    return defineTool({
      name: "hands_copy_file",
      description:
        "Copy a file of this workspace, by its id from list_files or recall, to a path on a machine, creating missing folders. It replaces a file at that path.",
      parameters: Type.Object({
        file: Type.String({ description: "The file id" }),
        machine: Type.String({ description: "Machine name" }),
        path: Type.String({
          description: "File path on the machine; ~ is the user's home",
        }),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const { path, name } = await this.fileIn(workspaceId, args.file).catch(
          () => {
            throw new Error(
              `There is no file ${args.file} in this workspace. list_files and recall show files.`
            );
          }
        );
        const target = await this.hands.put(
          workspaceId,
          await requesterOf(api.conversationId),
          args.machine,
          path,
          args.path
        );
        return {
          output: [
            {
              type: "text",
              text: `Copied ${name} to ${target} on ${args.machine}.`,
            },
          ],
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

  /**
   * Threads follow the model and effort chosen in settings, also after they change, and the instructions of this
   * version of Golem.
   */
  private async useCurrentAgent(
    workspaceId: string,
    conversation: Conversation
  ): Promise<void> {
    const model = this.currentModel();
    const thinkingLevel = this.llm.effort();
    const view = await conversation.watch(BACKGROUND_CONTEXT);
    await view.stop();
    const stored = view.value.docs["pi.agent"] as AgentState | undefined;
    const instructions =
      this.registry.orchestratorOf(workspaceId)?.conversationId ===
      conversation.id
        ? `${INSTRUCTIONS} ${ORCHESTRATOR}`
        : INSTRUCTIONS;
    if (
      stored?.model?.provider !== model.provider ||
      stored.model.modelId !== model.modelId ||
      stored.thinkingLevel !== thinkingLevel ||
      stored.instructions !== instructions
    ) {
      await conversation.configure(
        { model, thinkingLevel, instructions },
        BACKGROUND_CONTEXT
      );
    }
  }

  private currentModel() {
    return { provider: this.llm.providerId, modelId: this.llm.model() };
  }
}

/**
 * The entries before the view's head marker, which a compaction leaves out of the view. The transcript shows them
 * too, so a thread keeps all its messages.
 */
async function earlierEntries(
  conversation: Conversation,
  view: ConversationView
): Promise<EntryRecord[]> {
  const head = view.entries[0]?.head;
  const entries: EntryRecord[] = [];
  if (head === undefined) {
    return entries;
  }
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await conversation.entries(
      { maxEntryId: (head - 1) as EntryId, order: "ascending" },
      500,
      cursor,
      BACKGROUND_CONTEXT
    );
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return entries;
}

/**
 * The messages of a thread: the entries a compaction left out of the view first, then the view's. The agent's work
 * after a message, up to the next one, is one answer: its last words are the text, and the thoughts, tool calls, and
 * words before them are its work.
 */
export function threadMessages(
  view: ConversationView,
  earlier: readonly EntryRecord[] = []
): Omit<ThreadMessages, "approvals"> {
  const { running, generation } = liveOf(view);
  const messages: Message[] = [];
  let startedAt = 0;
  let turn: Turn | undefined;
  const answer = (streaming: boolean) => {
    const message = turn && turnMessage(turn, startedAt, streaming);
    // The answer to a task that needs nobody's attention.
    if (message && message.text.trim() !== "QUIET") {
      messages.push(message);
    }
    turn = undefined;
  };
  for (const entry of [...earlier, ...view.entries]) {
    const model = entry.model?.[0];
    if (
      entry.kind === AUTHORED ||
      entry.kind === RELAYED ||
      entry.kind === TASK
    ) {
      answer(false);
      startedAt = (model as UserMessage | undefined)?.timestamp ?? 0;
    }
    if (entry.kind === AUTHORED) {
      const data = entry.data as unknown as Authored;
      messages.push({
        id: String(entry.id),
        authorId: data.authorId,
        author: data.author,
        agent: false,
        text: data.text,
        // Messages from before files have none.
        files: data.files ?? [],
        time: startedAt,
        failed: false,
        streaming: false,
        work: null,
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
        time: startedAt,
        failed: false,
        streaming: false,
        work: null,
      });
    } else if (model?.role === "assistant") {
      turn ??= { id: String(entry.id), responses: [], results: new Map() };
      turn.responses.push(model);
    } else if (model?.role === "toolResult" && turn) {
      turn.results.set(model.toolCallId, model);
    } else if (entry.kind === STOPPED) {
      turn ??= { id: String(entry.id), responses: [], results: new Map() };
      turn.stoppedAt = (entry.data as { at: number }).at;
    }
  }
  if (running) {
    turn ??= { id: "streaming", responses: [], results: new Map() };
    if (generation) {
      turn.responses.push(generation);
    }
  }
  answer(running);
  return { messages, running };
}

/** Whether the agent works, and the response it is writing. */
function liveOf(view: ConversationView): {
  running: boolean;
  generation?: AssistantMessage;
} {
  const live = (view.docs["pi.live"] ?? {}) as {
    run?: unknown;
    generation?: { message?: AssistantMessage };
    tools?: unknown[];
  };
  return {
    running:
      live.run !== undefined ||
      live.generation !== undefined ||
      (live.tools ?? []).length > 0,
    generation: live.generation?.message,
  };
}

/** The agent's responses to one message, and the results of their tool calls by call id. */
interface Turn {
  readonly id: string;
  readonly responses: AssistantMessage[];
  readonly results: Map<string, ToolResultMessage>;
  /** When someone stopped the agent. */
  stoppedAt?: number;
}

function turnMessage(
  turn: Turn,
  startedAt: number,
  streaming: boolean
): Message {
  const steps = turnSteps(turn, streaming);
  // The words after the last thought or tool call are the answer.
  const answerStart = steps.findLastIndex((s) => s.kind !== "text") + 1;
  const answer = steps
    .slice(answerStart)
    .map((s) => s.text)
    .join("");
  const work = steps.slice(0, answerStart);
  const last = turn.responses.at(-1);
  // An aborted response, or tool calls that never got results, end a turn that someone stopped, or a restart cut.
  const stopped =
    !streaming &&
    (turn.stoppedAt !== undefined ||
      last?.stopReason === "aborted" ||
      last?.stopReason === "toolUse");
  const failed =
    !(streaming || stopped) &&
    answer === "" &&
    last?.errorMessage !== undefined;
  const ends = [
    ...turn.responses.map((r) => r.timestamp + (r.durationMs ?? 0)),
    ...[...turn.results.values()].map((r) => r.timestamp),
  ];
  const start = startedAt || (turn.responses[0]?.timestamp ?? Date.now());
  return {
    id: turn.id,
    authorId: null,
    author: "Golem",
    agent: true,
    text: failed ? last!.errorMessage! : answer,
    files: [],
    time: last?.timestamp ?? start,
    failed,
    streaming,
    work:
      streaming || stopped || work.length > 0
        ? {
            startedAt: start,
            endedAt: streaming
              ? null
              : (turn.stoppedAt ?? Math.max(start, ...ends)),
            stopped,
            steps: work,
          }
        : null,
  };
}

/** The thoughts, words, and tool calls of a turn in order; words that follow each other are one step. */
function turnSteps(turn: Turn, streaming: boolean): Step[] {
  const steps: Step[] = [];
  const add = (kind: Step["kind"], text: string) =>
    steps.push({
      kind,
      text,
      tool: null,
      input: null,
      output: null,
      running: false,
      failed: false,
    });
  for (const block of turn.responses.flatMap((r) => r.content)) {
    const last = steps.at(-1);
    if (block.type === "thinking") {
      if (block.thinking.trim() !== "") {
        add("thinking", block.thinking.trim());
      }
    } else if (block.type === "text") {
      if (last?.kind === "text") {
        steps[steps.length - 1] = { ...last, text: last.text + block.text };
      } else if (block.text.trim() !== "") {
        add("text", block.text);
      }
    } else {
      steps.push(toolStep(block, turn.results.get(block.id), streaming));
    }
  }
  return steps;
}

function toolStep(
  call: ToolCall,
  result: ToolResultMessage | undefined,
  streaming: boolean
): Step {
  const output = result?.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  return {
    kind: "tool",
    text: output?.match(THREAD_LINK)?.[0] ?? argumentSummary(call.arguments),
    tool: call.name,
    input: clip(JSON.stringify(call.arguments, null, 2)),
    output: output === undefined ? null : clip(output),
    running: streaming && !result,
    failed: result?.isError === true || call.argumentsError !== undefined,
  };
}

/** A thread link as agents write it: `[title](thread:<id>)`. */
const THREAD_LINK = /\[[^\]\n]+\]\(thread:[\w-]+\)/;
/** How much of a tool call's arguments and result the transcript keeps; the transcript is sent after every change. */
const DETAIL_LIMIT = 1000;

function clip(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/** The values of a tool call's arguments on one line, such as the query of a search. */
function argumentSummary(args: object): string {
  return Object.values(args)
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" · ")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

interface Authored extends JsonObject {
  readonly author: string;
  readonly authorId: string;
  readonly text: string;
  readonly files: FileRef[];
}

/** The person a message is for: its author, or the person whose request another thread's agent passes on. */
function requesterIdOf(input: EntryRecord): string | null {
  if (input.kind === AUTHORED) {
    return (input.data as unknown as Authored).authorId;
  }
  return input.kind === RELAYED
    ? (input.data as unknown as Relay).requesterId
    : null;
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
    content: `${minute(Date.now())} UTC ${user.name}: ${text}${attached}`,
    entry: { kind: AUTHORED, data },
  };
}

/** A message needs text, files, or both. */
/** The id that read_file or the artifact tools take, for a recalled file or artifact. */
function recalledId(uri: string): string {
  const artifact = /^artifact:(.+)$/.exec(uri);
  if (artifact) {
    return `, artifact ${artifact[1]}`;
  }
  const file = FILE_URI.exec(uri);
  return file ? `, file ${file[1]}` : "";
}

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
  requestId: string,
  requester: User | null,
  exposed: boolean
) {
  const data: Relay = {
    fromThreadId: from.id,
    fromTitle: from.title,
    hops: hops + 1,
    text,
    requesterId: requester?.id ?? null,
    requesterName: requester?.name ?? null,
    exposed,
  };
  return {
    content: `${minute(Date.now())} UTC Golem from ${threadLink(from)}: ${text}`,
    entry: { kind: RELAYED, data },
    requestId,
  };
}

/** The tool for codemode scripts only, so the model is not offered it. */
function scriptOnly<Tool extends ToolRegistration>(tool: Tool): Tool {
  return { ...tool, callers: ["tools"] };
}

/**
 * What the running turn of a conversation did since its input: whether it took in content that no member wrote,
 * whether no person watches it (a task such as a reminder or a routine run), and the machines a person allowed for it.
 */
async function turnOf(conversation: Conversation): Promise<{
  exposed: boolean;
  unattended: boolean;
  allowed: Set<string>;
  /** The machines whose changes the person allowed for every run of the turn's work. */
  granted: Set<string>;
}> {
  const allowed = new Set<string>();
  let exposed = false;
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await conversation.entries(
      { order: "descending" },
      50,
      cursor,
      BACKGROUND_CONTEXT
    );
    for (const entry of page.items) {
      if (entry.kind === EXPOSED) {
        exposed = true;
      } else if (entry.kind === ALLOWED) {
        allowed.add((entry.data as { machineId: string }).machineId);
      } else if (entry.kind === AUTHORED) {
        return { exposed, unattended: false, allowed, granted: new Set() };
      } else if (entry.kind === RELAYED) {
        const relay = entry.data as unknown as Relay;
        return {
          exposed: exposed || relay.exposed,
          unattended: false,
          allowed,
          granted: new Set(),
        };
      } else if (entry.kind === TASK) {
        return taskTurn(exposed, allowed, entry.data as unknown as Task);
      }
    }
    cursor = page.next;
  } while (cursor);
  return { exposed, unattended: true, allowed, granted: new Set() };
}

/** The turn of a task, such as a routine run, which no person watches. */
function taskTurn(
  exposed: boolean,
  allowed: Set<string>,
  // Tasks from before routines kept machines have neither field.
  task: Partial<Task>
) {
  return {
    exposed: exposed || task.exposed === true,
    unattended: true,
    allowed,
    granted: new Set(task.machineIds ?? []),
  };
}

/** What a tool that changes a machine is about to do, for the person who allows it. */
function actionText(
  tool: string,
  args: Record<string, unknown>,
  machine: string
): string {
  if (tool === "hands_exec" || tool === "hands_job_start") {
    return `Run on ${machine}: ${clip(String(args.command))}`;
  }
  const verb =
    { hands_write: "Write", hands_edit: "Edit" }[tool] ?? "Copy a file to";
  return `${verb} ${String(args.path)} on ${machine}`;
}

/**
 * The codemode tool with a deadline for each script: the script's own `timeout_ms`, at most `SCRIPT_DEADLINE`, so a
 * script that never ends stops. A script whose options do not parse goes on as it is, and fails there.
 */
function withDeadline(tool: ToolRegistration): ToolRegistration {
  return {
    ...tool,
    execute: (
      ...[args, api, context]: Parameters<ToolRegistration["execute"]>
    ) =>
      tool.execute(
        {
          ...(args as { code: string }),
          code: scriptWithDeadline((args as { code: string }).code),
        },
        api,
        context
      ),
  };
}

/** A codemode script's source with an options line whose `timeout_ms` is at most `SCRIPT_DEADLINE`. */
export function scriptWithDeadline(source: string): string {
  let parsed: ReturnType<typeof parseCodemodeSource>;
  try {
    parsed = parseCodemodeSource(source);
  } catch {
    return source;
  }
  const { code, options } = parsed;
  const line = `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify({
    timeout_ms: Math.min(options.timeoutMs ?? SCRIPT_DEADLINE, SCRIPT_DEADLINE),
    ...(options.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: options.maxOutputTokens }),
  })}`;
  // The parsed code keeps an empty first line where its options were, so line numbers stay.
  return code === source ? `${line}\n${code}` : `${line}${code}`;
}

/**
 * A connector's tool for the agent, for the person of the turn that calls it. Its result is the text the agent reads;
 * one that declares its value gives scripts that value.
 */
function connectorTool(
  tool: WorkspaceTool,
  requesterOf: (conversationId: ConversationId) => Promise<string | null>
) {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.outputSchema ? { structuredOutputSchema: tool.outputSchema } : {}),
    execute: async (args, api, context) => {
      const result = await tool.execute(args, {
        userId: await requesterOf(api.conversationId),
        signal: context.abortSignal,
      });
      const text =
        typeof result === "string"
          ? result
          : (JSON.stringify(result) ?? "null");
      return {
        output: [{ type: "text", text }],
        ...(tool.outputSchema
          ? { structuredOutput: result as JsonObject }
          : {}),
      };
    },
  });
}

/** A channel as the channel tools give it: its name and summary, then its five newest threads. */
function channelText(channel: Channel): string {
  const threads = channel.threads
    .slice(0, 5)
    .map((thread) => `- ${threadLink(thread)} (${day(thread.updatedAt)})`);
  const summary = channel.summary ? `: ${channel.summary}` : "";
  return [`#${channel.name}${summary}`, ...threads].join("\n");
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

/** A message as the memory reads it: its author, its text, and the names of its files. */
function saidText(message: Message): string {
  return `${message.author}: ${messageBody(message)}`;
}

/** The text of a message and the names of its files. */
function messageBody(message: Message): string {
  const files = message.files.length
    ? ` [attached: ${message.files.map((file) => file.name).join(", ")}]`
    : "";
  return `${message.text}${files}`;
}

function minute(time: number): string {
  return new Date(time).toISOString().slice(0, 16).replace("T", " ");
}

function day(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

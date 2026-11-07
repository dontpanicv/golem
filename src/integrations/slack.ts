import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import type {
  Connector,
  ConnectorTool,
  WatchedItem,
  WatchSource,
} from "./integrations.ts";

/** How long one slackcli command may take. */
const RUN_MS = 60 * 1000;
const LIMIT = Type.Optional(
  Type.Integer({ minimum: 1, maximum: 200, description: "At most." })
);
const RECIPIENT = Type.String({
  description:
    "A `#channel`, a person's `@handle` or email, or a channel or user ID; a name shows the person whom it goes to.",
});
const THREAD = Type.Optional(
  Type.String({
    description: "The `ts` of a message, to reply in its thread.",
  })
);

/**
 * Slack through slackcli (https://github.com/shaharia-lab/slackcli), with the session of the person's browser, which
 * they give as a request of Slack's web app copied as cURL. It is not a Slack app, so it needs no administrator. Agents
 * read, draft, and send messages when the person allows each one.
 */
export function slackConnector(binary: string): Connector {
  const slack = new SlackCli(binary);
  return {
    id: "slack",
    name: "Slack",
    description:
      "The person's Slack: search messages, read channels, threads, unread messages, and canvases, find people, draft messages, and send messages after the person allows each one.",
    secretLabel: "cURL",
    guide: [
      "Open your Slack workspace in Chrome or Firefox, at [app.slack.com](https://app.slack.com).",
      "Open the developer tools, select **Network**, and type `api/` in the filter. Open a channel.",
      "Right-click a request such as `conversations.history`, and select **Copy › Copy as cURL**. On Windows, select **Copy as cURL (bash)**.",
      "Click **Add credential**, and paste it. Signing out of Slack in that browser ends the session.",
    ],
    secretFrom: (curl) => slack.signIn(curl),
    watch: (source) => watchSlack(slack, source),
    observations: async (tool, args, result, source) => {
      if (tool !== "slack_search" && tool !== "slack_read") {
        return [];
      }
      return readSlack(tool, args, result, slackOwnerId(await source.secret()));
    },
    tools: [
      slackTool(slack, {
        name: "slack_search",
        description:
          "Messages that match a query, newest first. The query takes Slack's search operators, such as `in:#family` or `from:@ada`.",
        parameters: Type.Object({
          query: Type.String(),
          limit: LIMIT,
          page: Type.Optional(
            Type.Integer({ minimum: 1, description: "1 when not given." })
          ),
        }),
        command: ({ query, limit, page }) => [
          "search",
          "messages",
          ...option("limit", limit),
          ...option("page", page),
          "--",
          query,
        ],
      }),
      slackTool(slack, {
        name: "slack_conversations",
        description:
          "The channels, group messages, and direct messages of the person. Pass `cursor` for the next page.",
        parameters: Type.Object({
          limit: LIMIT,
          cursor: Type.Optional(Type.String()),
        }),
        command: ({ limit, cursor }) => [
          "conversations",
          "list",
          "--exclude-archived",
          ...option("limit", limit),
          ...option("cursor", cursor),
        ],
      }),
      slackTool(slack, {
        name: "slack_read",
        description:
          "The newest messages of a channel or direct message, or of one thread. `oldest` and `latest` are Slack timestamps or Unix seconds.",
        parameters: Type.Object({
          channel: Type.String({
            description: "A channel ID, name, or Slack link.",
          }),
          thread: THREAD,
          limit: LIMIT,
          oldest: Type.Optional(Type.String()),
          latest: Type.Optional(Type.String()),
        }),
        command: ({ channel, thread, limit, oldest, latest }) => [
          "conversations",
          "read",
          ...option("thread-ts", thread),
          ...option("limit", limit),
          ...option("oldest", oldest),
          ...option("latest", latest),
          "--",
          channel,
        ],
      }),
      slackTool(slack, {
        name: "slack_unread",
        description:
          "The conversations with unread messages, and those messages and thread replies.",
        parameters: Type.Object({
          conversations: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 100,
              description:
                "At most this many conversations; 10 when not given.",
            })
          ),
          limit: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 200,
              description:
                "At most this many messages of each conversation or thread; 20 when not given.",
            })
          ),
        }),
        command: ({ conversations, limit }) => [
          "conversations",
          "unread",
          "--messages",
          ...option("max-conversations", conversations),
          ...option("limit", limit),
        ],
      }),
      slackTool(slack, {
        name: "slack_people",
        description: "People whose name, handle, or email matches.",
        parameters: Type.Object({ query: Type.String(), limit: LIMIT }),
        command: ({ query, limit }) => [
          "search",
          "people",
          ...option("limit", limit),
          "--",
          query,
        ],
      }),
      slackTool(slack, {
        name: "slack_canvas",
        description: "A canvas as Markdown.",
        parameters: Type.Object({
          canvas: Type.String({ description: "The canvas's ID or link." }),
        }),
        command: ({ canvas }) => ["canvas", "read", "--", canvas],
      }),
      slackTool(slack, {
        name: "slack_draft",
        description:
          "Writes a draft in Slack that the person reads and sends from Slack.",
        parameters: Type.Object({
          to: RECIPIENT,
          text: Type.String(),
          thread: THREAD,
        }),
        command: ({ to, text, thread }) => [
          "messages",
          "draft",
          ...option("recipient-id", to),
          ...option("message", text),
          ...option("thread-ts", thread),
        ],
      }),
      {
        ...slackTool(slack, {
          name: "slack_send",
          description:
            "Sends a message as the person, after they allow it; for a draft that they want to read first, use slack_draft.",
          parameters: Type.Object({
            to: RECIPIENT,
            text: Type.String(),
            thread: THREAD,
          }),
          command: ({ to, text, thread }) => [
            "messages",
            "send",
            ...option("recipient-id", to),
            ...option("message", text),
            ...option("thread-ts", thread),
          ],
        }),
        approval: ({ to, text, thread }) =>
          `Send on Slack to ${to}${thread ? " in a thread" : ""}: ${text}`,
      },
    ],
  };
}

/** The pages of each search that one watch reads at most. */
const WATCH_PAGES = 5;

/** A message as `slackcli search messages --json` gives it. */
export interface SlackMessage {
  readonly channel: {
    readonly id: string;
    readonly name?: string;
    readonly is_im?: boolean;
    readonly is_mpim?: boolean;
  };
  readonly user?: string;
  readonly username?: string;
  readonly ts: string;
  readonly thread_ts?: string;
  readonly text: string;
  readonly permalink: string;
}

function readSlack(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  ownerId: string
): WatchedItem[] {
  const response = result as {
    matches?: SlackMessage[];
    messages?: SlackMessage[];
    channel?: SlackMessage["channel"];
  };
  const messages =
    (tool === "slack_search" ? response.matches : response.messages) ?? [];
  const normalized = messages.flatMap((message) => {
    const target =
      typeof args.channel === "string" && /^[CDG][A-Z0-9]+$/.test(args.channel)
        ? args.channel
        : null;
    const channel =
      message.channel ??
      response.channel ??
      (target ? { id: target, is_im: target.startsWith("D") } : undefined);
    if (!(channel?.id && message.ts) || typeof message.text !== "string") {
      return [];
    }
    return [
      {
        ...message,
        channel,
        thread_ts:
          message.thread_ts ??
          (typeof args.thread === "string" ? args.thread : undefined),
      },
    ];
  });
  const followed = new Set(
    normalized
      .filter((message) => personalSlackMessage(message, ownerId))
      .map(
        (message) => `${message.channel.id}/${message.thread_ts ?? message.ts}`
      )
  );
  return normalized.flatMap((message) => {
    const item = observedSlackMessage(message, ownerId, followed);
    return item && Number.isFinite(item.at) ? [item] : [];
  });
}

interface FollowedThread {
  message: SlackMessage;
  root: string;
  oldest: string;
}
interface SlackWatchState {
  roots: Set<string>;
  resolved: Record<string, { root: string; at: number }>;
  pending: SlackMessage[];
  threads: FollowedThread[];
  remaining: number;
  items: Map<string, WatchedItem>;
}

/** Reads the person's messages, direct mentions, direct/group DMs, and replies in their followed threads. */
async function watchSlack(
  slack: SlackCli,
  source: WatchSource
): Promise<WatchedItem[]> {
  const session = await source.secret();
  const ownerId = slackOwnerId(session);
  const saved = (source.checkpoint?.value ?? {}) as {
    page?: number;
    complete?: boolean;
    through?: number;
    roots?: string[];
    resolved?: SlackWatchState["resolved"];
    pending?: SlackMessage[];
    threads?: FollowedThread[];
  };
  const state: SlackWatchState = {
    roots: new Set(saved.roots),
    resolved: saved.resolved ?? {},
    pending: [],
    threads: saved.threads ?? [],
    remaining: 25,
    items: new Map(),
  };
  const through = saved.through ?? Date.now();
  const query = `after:${new Date(source.since - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}`;
  let page = saved.page ?? 1,
    complete = saved.complete ?? false;
  await readSlackMessages(
    slack,
    session,
    source,
    ownerId,
    saved.pending ?? [],
    state
  );
  for (
    let scanned = 0;
    scanned < WATCH_PAGES &&
    !complete &&
    state.remaining > 0 &&
    !state.pending.length;
    scanned += 1
  ) {
    const response = (await slack.run(
      session,
      [
        "search",
        "messages",
        "--limit=100",
        `--page=${page}`,
        "--sort=timestamp",
        "--sort-dir=asc",
        "--",
        query,
      ],
      source.signal
    )) as { matches?: SlackMessage[]; pages?: number };
    // A search gives every channel's messages; only the selected ones, which intake records, belong in the audit.
    source.record?.("raw", {
      query,
      page,
      matches: response.matches?.length ?? 0,
      pages: response.pages ?? 1,
    });
    await readSlackMessages(
      slack,
      session,
      source,
      ownerId,
      response.matches ?? [],
      state
    );
    if (page >= (response.pages ?? 1)) {
      complete = true;
      break;
    }
    page += 1;
  }
  await readSlackThreads(slack, session, source, ownerId, state);
  const resolved = Object.fromEntries(
    Object.entries(state.resolved).filter(
      ([, value]) => value.at >= source.since - 24 * 60 * 60 * 1000
    )
  );
  const covered = complete && !state.pending.length && !state.threads.length;
  source.checkpoint?.save({
    page: covered ? undefined : page,
    complete: covered ? undefined : complete,
    through: covered ? undefined : through,
    roots: [...state.roots],
    resolved,
    pending: state.pending,
    threads: state.threads,
  });
  source.record?.("coverage", {
    complete: covered,
    ...(covered
      ? { through }
      : { reason: "Slack page or thread lookup budget" }),
  });
  source.record?.("filter", {
    kept: state.items.size,
    followedThreads: state.roots.size,
    pending: state.pending.length,
    threadReads: state.threads.length,
  });
  return [...state.items.values()];
}

function slackOwnerId(session: string): string {
  const credentials = JSON.parse(session) as SlackWorkspaces;
  const choices = Object.values(credentials.workspaces);
  let workspace = choices.length === 1 ? choices[0] : undefined;
  if (credentials.default_workspace) {
    workspace = credentials.workspaces[credentials.default_workspace];
  }
  if (!workspace?.user_id) {
    throw new Error("The Slack session has no user identity");
  }
  return workspace.user_id;
}

async function readSlackMessages(
  slack: SlackCli,
  session: string,
  source: WatchSource,
  ownerId: string,
  messages: SlackMessage[],
  state: SlackWatchState
): Promise<void> {
  // Discover participation first, so an earlier untagged reply in this page is included too.
  const ordered = messages.toSorted(
    (a, b) =>
      Number(personalSlackMessage(b, ownerId)) -
      Number(personalSlackMessage(a, ownerId))
  );
  for (const message of ordered) {
    if (!message.text.trim() || Number(message.ts) * 1000 < source.since) {
      continue;
    }
    const direct = message.channel.is_im || message.channel.is_mpim;
    const personal = personalSlackMessage(message, ownerId);
    const followedChannel = [...state.roots].some((root) =>
      root.startsWith(`${message.channel.id}/`)
    );
    if (!(direct || personal || followedChannel)) {
      continue;
    }
    const resolved = direct
      ? message
      : await resolveSlackMessage(
          slack,
          session,
          source,
          ownerId,
          message,
          state
        );
    if (!resolved) {
      continue;
    }
    const item = observedSlackMessage(resolved, ownerId, state.roots);
    if (item) {
      state.items.set(item.id, item);
    }
  }
}

async function resolveSlackMessage(
  slack: SlackCli,
  session: string,
  source: WatchSource,
  ownerId: string,
  message: SlackMessage,
  state: SlackWatchState
): Promise<SlackMessage | undefined> {
  const key = `${message.channel.id}/${message.ts}`;
  let root =
    message.thread_ts ??
    new URL(message.permalink).searchParams.get("thread_ts") ??
    state.resolved[key]?.root;
  if (!root) {
    if (!state.remaining) {
      state.pending.push(message);
      return undefined;
    }
    state.remaining -= 1;
    try {
      const response = (await slack.run(
        session,
        [
          "conversations",
          "get",
          "--fields=ts,thread_ts",
          `--permalink=${message.permalink}`,
        ],
        source.signal
      )) as { message: { ts: string; thread_ts?: string } };
      source.record?.("raw", { tool: "get", id: key, response });
      root = response.message.thread_ts ?? response.message.ts;
      state.resolved[key] = { root, at: Number(message.ts) * 1000 };
    } catch (error) {
      source.record?.("lookup.error", { id: key, error: String(error) });
      state.pending.push(message);
      return undefined;
    }
    await Bun.sleep(1500);
  }
  const threadKey = `${message.channel.id}/${root}`;
  if (personalSlackMessage(message, ownerId) && !state.roots.has(threadKey)) {
    state.roots.add(threadKey);
    state.threads.push({
      message,
      root,
      oldest: String(source.since / 1000 - 0.000_001),
    });
  }
  return { ...message, thread_ts: root };
}

async function readSlackThreads(
  slack: SlackCli,
  session: string,
  source: WatchSource,
  ownerId: string,
  state: SlackWatchState
): Promise<void> {
  const pending: FollowedThread[] = [];
  for (const thread of state.threads) {
    if (!state.remaining) {
      pending.push(thread);
      continue;
    }
    state.remaining -= 1;
    try {
      const response = (await slack.run(
        session,
        [
          "conversations",
          "read",
          `--thread-ts=${thread.root}`,
          `--oldest=${thread.oldest}`,
          "--limit=100",
          "--",
          thread.message.channel.id,
        ],
        source.signal
      )) as {
        messages?: Omit<SlackMessage, "channel" | "permalink">[];
        has_more?: boolean;
        next_oldest?: string;
      };
      source.record?.("raw", { tool: "thread", root: thread.root, response });
      for (const message of response.messages ?? []) {
        if (Number(message.ts) * 1000 < source.since) {
          continue;
        }
        const permalink = thread.message.permalink.replace(
          /\/p\d+/,
          `/p${message.ts.replace(".", "")}`
        );
        state.resolved[`${thread.message.channel.id}/${message.ts}`] = {
          root: thread.root,
          at: Number(message.ts) * 1000,
        };
        const item = observedSlackMessage(
          {
            ...message,
            channel: thread.message.channel,
            permalink,
            thread_ts: thread.root,
          },
          ownerId,
          state.roots
        );
        if (item) {
          state.items.set(item.id, item);
        }
      }
      if (response.has_more) {
        const oldest = response.next_oldest;
        if (!oldest || Number(oldest) <= Number(thread.oldest)) {
          throw new Error("Slack thread pagination did not advance");
        }
        pending.push({ ...thread, oldest });
      }
    } catch (error) {
      source.record?.("lookup.error", {
        root: thread.root,
        error: String(error),
      });
      pending.push(thread);
    }
    await Bun.sleep(1500);
  }
  state.threads = pending;
}

function personalSlackMessage(message: SlackMessage, ownerId: string): boolean {
  return message.user === ownerId || message.text.includes(`<@${ownerId}>`);
}

/** The source selection rule, also used when replaying captured Slack records. */
export function observedSlackMessage(
  message: SlackMessage,
  ownerId: string,
  followed: ReadonlySet<string>
): WatchedItem | null {
  const direct = message.channel.is_im === true;
  const groupDirect = message.channel.is_mpim === true;
  const root = message.thread_ts ?? message.ts;
  if (
    !(
      message.text.trim() &&
      (direct ||
        groupDirect ||
        personalSlackMessage(message, ownerId) ||
        followed.has(`${message.channel.id}/${root}`))
    )
  ) {
    return null;
  }
  let chatName = `#${message.channel.name ?? message.channel.id}`;
  if (direct) {
    chatName = "Direct message";
  }
  if (groupDirect) {
    chatName = "Group direct message";
  }
  return {
    id: `${message.channel.id}/${message.ts}`,
    kind: "message",
    chat:
      direct || groupDirect
        ? message.channel.id
        : `${message.channel.id}/${root}`,
    chatName,
    group: !direct,
    sender:
      message.user === ownerId ? "" : (message.username ?? message.user ?? ""),
    fromOwner: message.user === ownerId,
    at: Math.floor(Number(message.ts) * 1000),
    text: message.text.replaceAll(`<@${ownerId}>`, "@me"),
    url: message.permalink ?? null,
  };
}

/**
 * Runs slackcli with a person's session, in a home of its own for each command, so it never uses the sessions of this
 * machine's user. The session is slackcli's `workspaces.json`, which Golem keeps encrypted.
 */
class SlackCli {
  constructor(private readonly binary: string) {}

  /** Signs in with the cURL command of a request of Slack's web app; gives the session and the workspace's name. */
  signIn(curl: string): Promise<{ secret: string; label: string }> {
    return this.inHome(async (home) => {
      await this.spawn(
        ["auth", "parse-curl", "--login", "--secret-backend", "file"],
        home,
        undefined,
        curl
      );
      const secret = readFileSync(workspacesOf(home), "utf8");
      const [workspace] = Object.values(
        (JSON.parse(secret) as SlackWorkspaces).workspaces
      );
      return { secret, label: workspace?.workspace_name ?? "Slack" };
    });
  }

  /** Runs a command with `--json` and the session, and returns its JSON answer. */
  run(
    session: string,
    command: readonly string[],
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    return this.inHome(async (home) => {
      writeFileSync(workspacesOf(home), session, { mode: 0o600 });
      const end = command.indexOf("--");
      const flags = end === -1 ? command : command.slice(0, end);
      const output = await this.spawn(
        [...flags, "--json", ...(end === -1 ? [] : command.slice(end))],
        home,
        signal
      );
      return output.trim() ? JSON.parse(output) : { done: true };
    });
  }

  private async spawn(
    command: readonly string[],
    home: string,
    signal: AbortSignal | undefined,
    input?: string
  ): Promise<string> {
    const {
      SLACKCLI_WORKSPACE: _workspace,
      SLACKCLI_TOKEN: _token,
      SLACK_BOT_TOKEN: _bot,
      ...env
    } = Bun.env;
    const process = Bun.spawn([this.binary, ...command], {
      env: {
        ...env,
        HOME: home,
        SLACKCLI_NO_UPDATE_NOTIFIER: "1",
        NO_COLOR: "1",
      },
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: RUN_MS,
      ...(signal ? { signal } : {}),
    });
    const [output, errors, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code !== 0) {
      throw new Error(
        failure(errors) ?? `Slack failed (slackcli exited with ${code})`
      );
    }
    return output;
  }

  /** Runs `use` with a new home, only for this machine's user, and removes the home after. */
  private async inHome<Result>(
    use: (home: string) => Promise<Result>
  ): Promise<Result> {
    const home = mkdtempSync(join(tmpdir(), "golem-slack-"));
    try {
      mkdirSync(join(workspacesOf(home), ".."), {
        recursive: true,
        mode: 0o700,
      });
      return await use(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

/** Where slackcli keeps its sessions in a home. */
function workspacesOf(home: string): string {
  return join(home, ".config", "slackcli", "workspaces.json");
}

interface SlackWorkspaces {
  readonly default_workspace?: string;
  readonly workspaces: Record<
    string,
    { readonly workspace_name?: string; readonly user_id?: string }
  >;
}

/**
 * The error that slackcli wrote: the `message` of the JSON line of a `--json` command, else the lines from `Error:` to
 * the first empty one.
 */
export function failure(errors: string): string | undefined {
  const lines = errors.split("\n");
  for (const line of lines.toReversed()) {
    try {
      const message = (JSON.parse(line) as { error?: { message?: string } })
        .error?.message;
      if (message) {
        return message;
      }
    } catch {
      // Not the JSON line.
    }
  }
  const start = lines.findIndex((line) => line.includes("Error:"));
  if (start === -1) {
    return undefined;
  }
  const end = lines.indexOf("", start);
  return lines
    .slice(start, end === -1 ? undefined : end)
    .map((line) => line.trim())
    .join(" ")
    .replace(/^.*?Error:\s*/, "");
}

/** A tool that runs one slackcli command with the session of the call's account. */
function slackTool<Parameters extends TSchema>(
  slack: SlackCli,
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
    execute: (args, session, signal) =>
      slack.run(session, tool.command(args), signal),
  };
}

/** A flag with its value in one argument, so a value that starts with `-` stays a value. */
function option(flag: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [`--${flag}=${value}`];
}

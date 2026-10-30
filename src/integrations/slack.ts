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
import type { Connector, ConnectorTool } from "./integrations.ts";

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
  readonly workspaces: Record<string, { readonly workspace_name?: string }>;
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

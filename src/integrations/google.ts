import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import type { Connector, ConnectorTool, FileOf } from "./integrations.ts";
import { PASTE_ADDRESS, SIGN_IN_ADDRESS } from "./sign-in.ts";

/** What the sign-in asks for: mail to read, draft, and send, events to manage, files to read, and files to create and share. */
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
];
/** How long one gog command may take. */
const RUN_MS = 60 * 1000;
/** The gog commands that Golem runs; gog refuses every other one. */
const COMMANDS = [
  "gmail.search",
  "gmail.thread.get",
  "gmail.drafts.list",
  "gmail.drafts.create",
  "gmail.drafts.update",
  "gmail.drafts.get",
  "gmail.drafts.send",
  "gmail.send",
  "calendar.calendars",
  "calendar.events",
  "calendar.event",
  "calendar.freebusy",
  "calendar.create",
  "calendar.update",
  "calendar.delete",
  "drive.search",
  "drive.get",
  "drive.upload",
  "drive.share",
  "docs.cat",
  "docs.create",
  "docs.write",
  "sheets.get",
];
const RECIPIENTS = Type.Optional(Type.Array(Type.String()));
const THREAD = Type.Optional(
  Type.String({ description: "The ID of the thread that it answers." })
);
const ATTACHED =
  "File ids from list_files or recall, such as a ZIP saved with save_file; together up to 25 MB, else upload them with google_drive_upload, share them, and put the link in the body.";
const ATTACHMENTS = Type.Optional(
  Type.Array(Type.String(), { description: ATTACHED })
);
const MAX = Type.Optional(
  Type.Integer({ minimum: 1, maximum: 100, description: "At most." })
);
const PAGE = Type.Optional(
  Type.String({ description: "`nextPageToken` of the previous page." })
);
const CALENDAR = Type.String({
  description:
    "The calendar's ID, from google_calendars; `primary` is the person's own.",
});
const EVENT = Type.String({ description: "The event's ID." });
const TIME = Type.String({
  description:
    "RFC 3339 with an offset, such as 2026-10-27T15:00:00+01:00; a date for an all-day event.",
});
const SCOPE = Type.Optional(
  Type.Union(
    [Type.Literal("single"), Type.Literal("future"), Type.Literal("all")],
    {
      description:
        "For a recurring event: this one, this and the next ones, or all; all when not given.",
    }
  )
);
const ORIGINAL_START = Type.Optional(
  Type.String({
    description: "The start of the occurrence, for scope single or future.",
  })
);

/**
 * Gmail, Google Calendar, and Google Drive through gog (https://github.com/openclaw/gogcli), which calls Google's APIs
 * with the access token of the person's sign-in. Agents read and draft mail, and send it when the person allows each
 * one; they manage events without sending invitations, read files, and upload files, create Docs, and share them
 * without sending invitations.
 */
export function googleConnector(binary: string): Connector {
  const gog = new Gog(binary);
  return {
    id: "google",
    name: "Google",
    description:
      "Gmail, Google Calendar, and Google Drive of each connected Google account. Search and read mail, draft mail, and send mail after the person allows it; read calendars, find free time, and create, change, and delete events; find and read files, upload files, create Google Docs, and share them.",
    secretLabel: null,
    oauth: "https://accounts.google.com",
    registered: true,
    scope: SCOPES.join(" "),
    guide: [
      "In the [Google Cloud console](https://console.cloud.google.com), select or create a project. In **APIs & Services › Library**, enable the Gmail, Google Calendar, Google Drive, Google Docs, and Google Sheets APIs.",
      "In **Google Auth Platform › Audience**, select **External** and **In production**. In Testing, Google ends each sign-in after 7 days.",
      `In **Data access**, add the scopes ${SCOPES.map((scope) => `\`${scope.replace("https://www.googleapis.com/auth/", "")}\``).join(", ")}.`,
      `In **Clients › Create client**, select **Web application**, and add the authorized redirect URI \`${SIGN_IN_ADDRESS}\`.`,
      "Click **Client** here, and paste the client ID and the client secret.",
      "Click **Connect**, and select the account. When Google tells you that it has not verified the app, click **Advanced**, then continue.",
      PASTE_ADDRESS,
      "Do this again for each account.",
      "A Google Workspace account that cannot sign in needs its administrator to trust the client ID in **Security › Access and data control › API controls**.",
    ],
    // A refresh token, and the choice of account, for each sign-in.
    authorizationParameters: {
      access_type: "offline",
      prompt: "consent select_account",
    },
    tools: [
      gogTool(gog, {
        name: "google_mail_search",
        description:
          "Mail threads that match a Gmail search, such as `from:anna newer_than:7d`, newest first.",
        parameters: Type.Object({ query: Type.String(), max: MAX, page: PAGE }),
        command: ({ query, max, page }) => [
          "gmail",
          "search",
          ...option("max", max),
          ...option("page", page),
          "--",
          query,
        ],
      }),
      gogTool(gog, {
        name: "google_mail_thread",
        description: "Every message of a mail thread, with its full text.",
        parameters: Type.Object({
          thread: Type.String({ description: "The thread's ID." }),
        }),
        command: ({ thread }) => [
          "gmail",
          "thread",
          "get",
          "--full",
          "--",
          thread,
        ],
      }),
      gogTool(gog, {
        name: "google_mail_drafts",
        description: "The person's drafts, newest first.",
        parameters: Type.Object({ max: MAX, page: PAGE }),
        command: ({ max, page }) => [
          "gmail",
          "drafts",
          "list",
          ...option("max", max),
          ...option("page", page),
        ],
      }),
      {
        name: "google_mail_draft",
        description:
          "Writes a draft that the person sends from Gmail, or that google_mail_send_draft sends after they allow it; or changes the draft `draft`. Give `thread` to reply in a thread.",
        parameters: Type.Object({
          subject: Type.String(),
          body: Type.String({ description: "Plain text." }),
          to: RECIPIENTS,
          cc: RECIPIENTS,
          bcc: RECIPIENTS,
          thread: THREAD,
          draft: Type.Optional(
            Type.String({ description: "The ID of a draft to change." })
          ),
          attachments: Type.Optional(
            Type.Array(Type.String(), {
              description: `${ATTACHED} For a draft to change, they replace its attachments.`,
            })
          ),
        }),
        execute: (
          { subject, body, to, cc, bcc, thread, draft, attachments },
          token,
          signal,
          file
        ) =>
          gog.withLinks(attachments ?? [], file, (paths) =>
            gog.run(
              token,
              [
                "gmail",
                "drafts",
                ...(draft ? ["update"] : ["create"]),
                `--subject=${subject}`,
                `--body=${body}`,
                ...option("to", to?.join(",")),
                ...option("cc", cc?.join(",")),
                ...option("bcc", bcc?.join(",")),
                ...option("thread-id", thread),
                ...paths.map((path) => `--attach=${path}`),
                ...(draft ? ["--", draft] : []),
              ],
              signal
            )
          ),
      },
      {
        name: "google_mail_send",
        description:
          "Sends mail as the person, after they allow it; for a draft that they want to read first, use google_mail_draft. Give `thread` to reply in a thread.",
        parameters: Type.Object({
          to: Type.Array(Type.String(), { minItems: 1 }),
          subject: Type.String(),
          body: Type.String({ description: "Plain text." }),
          cc: RECIPIENTS,
          bcc: RECIPIENTS,
          thread: THREAD,
          attachments: ATTACHMENTS,
        }),
        approval: async (
          { to, cc, bcc, subject, body, attachments },
          _token,
          _signal,
          file
        ) =>
          [
            `Send mail to ${[...to, ...(cc ?? []), ...(bcc ?? [])].join(", ")}: ${subject}`,
            body,
            ...(attachments?.length && file
              ? [
                  `Files: ${(await Promise.all(attachments.map(file))).map(({ name }) => name).join(", ")}`,
                ]
              : []),
          ].join("\n\n"),
        execute: (
          { to, subject, body, cc, bcc, thread, attachments },
          token,
          signal,
          file
        ) =>
          gog.withLinks(attachments ?? [], file, (paths) =>
            gog.run(
              token,
              [
                "gmail",
                "send",
                `--subject=${subject}`,
                `--body=${body}`,
                ...option("to", to.join(",")),
                ...option("cc", cc?.join(",")),
                ...option("bcc", bcc?.join(",")),
                ...option("thread-id", thread),
                ...paths.map((path) => `--attach=${path}`),
              ],
              signal,
              true
            )
          ),
      },
      {
        name: "google_mail_send_draft",
        description:
          "Sends a draft as it is in Gmail, after the person allows it, and removes the draft. google_mail_drafts lists the drafts.",
        parameters: Type.Object({
          draft: Type.String({ description: "The ID of the draft." }),
        }),
        approval: async ({ draft }, token, signal) =>
          `Send this Gmail draft:\n\n${await gog.text(token, ["gmail", "drafts", "get", "--", draft], signal)}`,
        execute: async ({ draft }, token, signal, _file, allowed) => {
          // The draft can change while the person reads it; only the draft that they allowed goes.
          const now = `Send this Gmail draft:\n\n${await gog.text(token, ["gmail", "drafts", "get", "--", draft], signal)}`;
          if (now !== allowed) {
            throw new Error(
              "The draft changed after the person allowed it; nothing was sent. Ask again."
            );
          }
          return gog.run(
            token,
            ["gmail", "drafts", "send", "--", draft],
            signal,
            true
          );
        },
      },
      gogTool(gog, {
        name: "google_calendars",
        description: "The calendars of the account, with their IDs.",
        parameters: Type.Object({}),
        command: () => ["calendar", "calendars", "--all"],
      }),
      gogTool(gog, {
        name: "google_calendar_events",
        description:
          "Events between two times, of one calendar or of all of them, soonest first.",
        parameters: Type.Object({
          from: Type.String({
            description: "RFC 3339, a date, or today, tomorrow, monday.",
          }),
          to: Type.String({ description: "As `from`." }),
          calendar: Type.Optional(CALENDAR),
          query: Type.Optional(
            Type.String({ description: "Words in the events." })
          ),
          max: MAX,
          page: PAGE,
        }),
        command: ({ from, to, calendar, query, max, page }) => [
          "calendar",
          "events",
          `--from=${from}`,
          `--to=${to}`,
          ...(calendar ? [] : ["--all"]),
          ...option("query", query),
          ...option("max", max),
          ...option("page", page),
          ...(calendar ? ["--", calendar] : []),
        ],
      }),
      gogTool(gog, {
        name: "google_calendar_event",
        description: "One event, with its guests and their answers.",
        parameters: Type.Object({ calendar: CALENDAR, event: EVENT }),
        command: ({ calendar, event }) => [
          "calendar",
          "event",
          "--",
          calendar,
          event,
        ],
      }),
      gogTool(gog, {
        name: "google_calendar_busy",
        description:
          "The busy times of calendars between two times; a calendar can be a person's email address.",
        parameters: Type.Object({
          from: Type.String({ description: "RFC 3339 or a date." }),
          to: Type.String({ description: "As `from`." }),
          calendars: Type.Optional(
            Type.Array(Type.String(), {
              description: "The person's own when not given.",
            })
          ),
        }),
        command: ({ from, to, calendars }) => [
          "calendar",
          "freebusy",
          `--from=${from}`,
          `--to=${to}`,
          ...(calendars ?? []).map((calendar) => `--cal=${calendar}`),
        ],
      }),
      gogTool(gog, {
        name: "google_calendar_create_event",
        description:
          "Creates an event. Guests get no invitation email; the person sends updates from Google Calendar.",
        parameters: Type.Object({
          calendar: CALENDAR,
          summary: Type.String({ description: "The title." }),
          from: TIME,
          to: TIME,
          all_day: Type.Optional(Type.Boolean()),
          location: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          guests: Type.Optional(
            Type.Array(Type.String(), { description: "Email addresses." })
          ),
          recurrence: Type.Optional(
            Type.Array(Type.String(), {
              description: "RRULE lines, such as RRULE:FREQ=WEEKLY;BYDAY=MO.",
            })
          ),
          meet: Type.Optional(
            Type.Boolean({ description: "Add a Google Meet link." })
          ),
        }),
        command: (event) => [
          "calendar",
          "create",
          `--summary=${event.summary}`,
          ...eventOptions(event),
          "--",
          event.calendar,
        ],
      }),
      gogTool(gog, {
        name: "google_calendar_update_event",
        description:
          "Changes an event: only what is given. `guests` replaces all guests. Guests get no email about the change.",
        parameters: Type.Object({
          calendar: CALENDAR,
          event: EVENT,
          summary: Type.Optional(Type.String({ description: "The title." })),
          from: Type.Optional(TIME),
          to: Type.Optional(TIME),
          all_day: Type.Optional(Type.Boolean()),
          location: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          guests: Type.Optional(
            Type.Array(Type.String(), { description: "Email addresses." })
          ),
          recurrence: Type.Optional(Type.Array(Type.String())),
          meet: Type.Optional(
            Type.Boolean({ description: "Add a Google Meet link." })
          ),
          scope: SCOPE,
          original_start: ORIGINAL_START,
        }),
        command: (event) => [
          "calendar",
          "update",
          ...option("summary", event.summary),
          ...eventOptions(event),
          ...option("scope", event.scope),
          ...option("original-start", event.original_start),
          "--",
          event.calendar,
          event.event,
        ],
      }),
      gogTool(gog, {
        name: "google_calendar_delete_event",
        description: "Deletes an event. Guests get no email about it.",
        parameters: Type.Object({
          calendar: CALENDAR,
          event: EVENT,
          scope: SCOPE,
          original_start: ORIGINAL_START,
        }),
        command: ({ calendar, event, scope, original_start }) => [
          "calendar",
          "delete",
          "--force",
          ...option("scope", scope),
          ...option("original-start", original_start),
          "--",
          calendar,
          event,
        ],
      }),
      gogTool(gog, {
        name: "google_drive_search",
        description:
          "Files in Drive whose name or text has the words, also in shared drives.",
        parameters: Type.Object({ query: Type.String(), max: MAX, page: PAGE }),
        command: ({ query, max, page }) => [
          "drive",
          "search",
          ...option("max", max),
          ...option("page", page),
          "--",
          query,
        ],
      }),
      gogTool(gog, {
        name: "google_drive_file",
        description: "A file's name, type, owner, dates, and link.",
        parameters: Type.Object({
          file: Type.String({ description: "The file's ID." }),
        }),
        command: ({ file }) => ["drive", "get", "--", file],
      }),
      {
        name: "google_drive_upload",
        description:
          "Uploads a file of the workspace to Drive, and gives its ID and link.",
        parameters: Type.Object({
          file: Type.String({
            description:
              "A file id from list_files or recall, such as a ZIP saved with save_file.",
          }),
          name: Type.Optional(
            Type.String({
              description: "The name in Drive; the file's own when not given.",
            })
          ),
          folder: Type.Optional(
            Type.String({ description: "The ID of a Drive folder." })
          ),
        }),
        execute: ({ file: fileId, name, folder }, token, signal, file) =>
          gog.withLinks([fileId], file, ([path]) =>
            gog.run(
              token,
              [
                "drive",
                "upload",
                ...option("name", name),
                ...option("parent", folder),
                "--",
                path!,
              ],
              signal
            )
          ),
      },
      gogTool(gog, {
        name: "google_drive_share",
        description:
          "Shares a Drive file that Golem uploaded or created: with anyone who has its link, a person, or a domain. Google sends no email; give the link in your answer or in a draft.",
        parameters: Type.Object({
          file: Type.String({ description: "The Drive file's ID." }),
          to: Type.Union(
            [
              Type.Literal("anyone"),
              Type.Literal("user"),
              Type.Literal("domain"),
            ],
            { description: "anyone: everyone with the link." }
          ),
          email: Type.Optional(
            Type.String({
              description: "The person's email address, for user.",
            })
          ),
          domain: Type.Optional(
            Type.String({ description: "Such as example.com, for domain." })
          ),
          role: Type.Optional(
            Type.Union(
              [
                Type.Literal("reader"),
                Type.Literal("commenter"),
                Type.Literal("writer"),
              ],
              { description: "reader when not given." }
            )
          ),
        }),
        command: ({ file, to, email, domain, role }) => [
          "drive",
          "share",
          `--to=${to}`,
          ...option("email", email),
          ...option("domain", domain),
          ...option("role", role),
          "--",
          file,
        ],
      }),
      gogTool(gog, {
        name: "google_docs_read",
        description: "The text of a Google Doc, with every tab.",
        parameters: Type.Object({
          document: Type.String({ description: "The Doc's ID." }),
        }),
        command: ({ document }) => [
          "docs",
          "cat",
          "--all-tabs",
          "--",
          document,
        ],
      }),
      gogTool(gog, {
        name: "google_sheets_read",
        description: "The values of a range of a Google Sheet.",
        parameters: Type.Object({
          spreadsheet: Type.String({ description: "The Sheet's ID." }),
          range: Type.String({ description: "Such as Sheet1!A1:D20." }),
        }),
        command: ({ spreadsheet, range }) => [
          "sheets",
          "get",
          "--",
          spreadsheet,
          range,
        ],
      }),
      {
        name: "google_docs_create",
        description:
          "Creates a Google Doc from Markdown, and gives its ID and link.",
        parameters: Type.Object({
          title: Type.String(),
          markdown: Type.String(),
          folder: Type.Optional(
            Type.String({ description: "The ID of a Drive folder." })
          ),
        }),
        execute: ({ title, markdown, folder }, token, signal) =>
          gog.withFile(`${title}.md`, markdown, (file) =>
            gog.run(
              token,
              [
                "docs",
                "create",
                `--file=${file}`,
                ...option("parent", folder),
                "--",
                title,
              ],
              signal
            )
          ),
      },
      gogTool(gog, {
        name: "google_docs_write",
        description:
          "Replaces the text of a Google Doc with Markdown, or adds it at the end. Only for Docs that Golem created.",
        parameters: Type.Object({
          document: Type.String({ description: "The Doc's ID." }),
          markdown: Type.String(),
          append: Type.Optional(
            Type.Boolean({ description: "Add at the end." })
          ),
        }),
        command: ({ document, markdown, append }) => [
          "docs",
          "write",
          "--markdown",
          append ? "--append" : "--replace",
          `--text=${markdown}`,
          "--",
          document,
        ],
      }),
    ],
  };
}

/** Runs gog with a person's access token, in a home of its own, so it never uses the tokens of this machine's user. */
class Gog {
  private readonly home = join(tmpdir(), "golem-gog");

  constructor(private readonly binary: string) {
    mkdirSync(this.home, { recursive: true });
  }

  /** Runs one of `COMMANDS`, and returns its JSON answer. Only a command that `sends` may send mail. */
  async run(
    token: string,
    command: readonly string[],
    signal: AbortSignal | undefined,
    sends = false
  ): Promise<unknown> {
    const output = await this.spawn(
      token,
      [
        "--json",
        "--results-only",
        "--wrap-untrusted",
        ...(sends ? [] : ["--gmail-no-send"]),
      ],
      command,
      signal
    );
    return output.trim() ? JSON.parse(output) : { done: true };
  }

  /** Runs one of `COMMANDS` that reads, and returns the text that gog writes for people. */
  async text(
    token: string,
    command: readonly string[],
    signal: AbortSignal | undefined
  ): Promise<string> {
    return (
      await this.spawn(
        token,
        ["--color=never", "--gmail-no-send"],
        command,
        signal
      )
    ).trim();
  }

  private async spawn(
    token: string,
    flags: readonly string[],
    command: readonly string[],
    signal: AbortSignal | undefined
  ): Promise<string> {
    const process = Bun.spawn(
      [
        this.binary,
        ...flags,
        "--no-input",
        `--enable-commands-exact=${COMMANDS.join(",")}`,
        ...command,
      ],
      {
        // The token goes in the environment, where other users' processes cannot read it.
        env: { ...Bun.env, GOG_ACCESS_TOKEN: token, GOG_HOME: this.home },
        stdout: "pipe",
        stderr: "pipe",
        timeout: RUN_MS,
        ...(signal ? { signal } : {}),
      }
    );
    const [output, errors, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code !== 0) {
      throw new Error(
        errors
          .split("\n")
          .filter((line) => line && !line.startsWith("Note:"))
          .join("\n") || `Google failed (gog exited with ${code})`
      );
    }
    return output;
  }

  /** Runs `use` with a file of `content`, which gog reads, and removes the file after. */
  withFile<Result>(
    name: string,
    content: string,
    use: (file: string) => Promise<Result>
  ): Promise<Result> {
    return this.inDirectory(async (directory) => {
      const file = join(directory, name.replaceAll("/", "-"));
      writeFileSync(file, content);
      return await use(file);
    });
  }

  /**
   * Runs `use` with a link to each workspace file, named as the file, so gog attaches it under its own name; removes
   * the links after.
   */
  async withLinks<Result>(
    fileIds: readonly string[],
    file: FileOf | undefined,
    use: (paths: string[]) => Promise<Result>
  ): Promise<Result> {
    if (fileIds.length > 0 && !file) {
      throw new Error("Only an agent in a thread can attach files.");
    }
    const files = await Promise.all(fileIds.map((fileId) => file!(fileId)));
    return this.inDirectory((directory) =>
      use(
        files.map(({ path, name }, index) => {
          // gog splits `--attach` at commas, and two files can have one name.
          const link = join(
            directory,
            String(index),
            name.replaceAll(",", " ")
          );
          mkdirSync(join(directory, String(index)));
          symlinkSync(path, link);
          return link;
        })
      )
    );
  }

  private async inDirectory<Result>(
    use: (directory: string) => Promise<Result>
  ): Promise<Result> {
    const directory = join(this.home, crypto.randomUUID());
    mkdirSync(directory);
    try {
      return await use(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

/** A tool that runs one gog command with the access token of the call's account. */
function gogTool<Parameters extends TSchema>(
  gog: Gog,
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
    execute: (args, token, signal) =>
      gog.run(token, tool.command(args), signal),
  };
}

/** The options of an event that create and update share. */
function eventOptions(event: {
  from?: string;
  to?: string;
  all_day?: boolean;
  location?: string;
  description?: string;
  guests?: string[];
  recurrence?: string[];
  meet?: boolean;
}): string[] {
  return [
    ...option("from", event.from),
    ...option("to", event.to),
    ...(event.all_day ? ["--all-day"] : []),
    ...option("location", event.location),
    ...option("description", event.description),
    ...option("attendees", event.guests?.join(",")),
    ...(event.recurrence ?? []).map((rule) => `--rrule=${rule}`),
    ...(event.meet ? ["--with-meet"] : []),
  ];
}

/** A flag with its value in one argument, so a value that starts with `-` stays a value. */
function option(flag: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [`--${flag}=${value}`];
}

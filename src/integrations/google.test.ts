import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleConnector } from "./google.ts";
import type { FileOf } from "./integrations.ts";

const directory = await mkdtemp(join(tmpdir(), "golem-google-test-"));
const gog = join(directory, "gog");
// gog as Golem runs it: it answers with its arguments, its token, and the content of a file it reads; `fail` fails.
await Bun.write(
  gog,
  `#!/bin/sh
for argument; do
  case "$argument" in
    --file=*) content=$(cat "\${argument#--file=}") ;;
    --out=*) echo "$*" > "\${argument#--out=}" ;;
    --attach=*) content="$content$(basename "\${argument#--attach=}")=$(cat "\${argument#--attach=}");" ;;
    fail) echo "Note: Using direct access token" >&2; echo "Google API error (404): not found" >&2; exit 5 ;;
  esac
done
printf '{"arguments":"%s","token":"%s","content":"%s"}' "$*" "$GOG_ACCESS_TOKEN" "$content"
`
);
await chmod(gog, 0o755);
const tools = new Map(
  googleConnector(gog).tools.map((tool) => [tool.name, tool])
);
afterAll(() => rm(directory, { recursive: true }));

async function call(name: string, args: object, file?: FileOf) {
  return (await tools
    .get(name)!
    .execute(args as never, "token-1", undefined, file)) as {
    arguments: string;
    token: string;
    content: string;
  };
}

test("mail observations decode original MIME bodies and exclude drafts and search summaries", async () => {
  const connector = googleConnector(gog);
  const source = { account: "alice@example.com", secret: async () => "unused" };
  const result = {
    thread: {
      id: "conversation",
      messages: [
        {
          id: "reply",
          threadId: "conversation",
          internalDate: "1790841600000",
          labelIds: ["SENT"],
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "From", value: "Alice" },
              { name: "Subject", value: "Repairs" },
            ],
            parts: [
              {
                mimeType: "text/plain",
                body: {
                  data: Buffer.from("The repair is complete.").toString(
                    "base64url"
                  ),
                },
              },
              {
                mimeType: "text/html",
                body: {
                  data: Buffer.from("<p>The repair is complete.</p>").toString(
                    "base64url"
                  ),
                },
              },
              {
                mimeType: "application/pdf",
                filename: "receipt.pdf",
                body: { attachmentId: "attachment", size: 42 },
              },
            ],
          },
        },
        {
          id: "draft",
          labelIds: ["DRAFT"],
          payload: {},
        },
      ],
    },
  };
  const items = await connector.observations!(
    "google_mail_thread",
    {},
    result,
    source
  );
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    id: "reply",
    chat: "conversation",
    at: 1_790_841_600_000,
    fromOwner: true,
    text: "Subject: Repairs\n\nThe repair is complete.",
    attachments: [
      {
        id: "attachment",
        name: "receipt.pdf",
        type: "application/pdf",
        size: 42,
      },
    ],
  });
  for (const tool of [
    "google_mail_search",
    "google_mail_draft",
    "google_mail_drafts",
    "google_mail_send",
  ]) {
    expect(await connector.observations!(tool, {}, result, source)).toEqual([]);
  }
  const html = {
    thread: {
      id: "conversation",
      messages: [
        {
          id: "html",
          labelIds: ["INBOX", "CATEGORY_PERSONAL"],
          internalDate: 1_790_841_600_000,
          payload: {
            mimeType: "text/html",
            body: {
              data: Buffer.from("<p>Confirmed.</p>").toString("base64url"),
            },
          },
        },
      ],
    },
  };
  expect(
    (await connector.observations!("google_mail_thread", {}, html, source))[0]!
      .text
  ).toContain("Confirmed.");
});

test("each tool runs one allowed gog command, with the token outside its arguments", async () => {
  const answer = await call("google_mail_draft", {
    subject: "Dinner",
    body: "--see you",
    to: ["anna@example.com", "otto@example.com"],
    thread: "t1",
  });
  expect(answer.token).toBe("token-1");
  expect(answer.arguments).not.toContain("token-1");
  expect(answer.arguments).toStartWith(
    "--json --results-only --wrap-untrusted --gmail-no-send --no-input --enable-commands-exact=gmail.search,"
  );
  // Only the tool that sends may send, after a person allows it.
  const send = await call("google_mail_send", {
    to: ["anna@example.com"],
    subject: "Dinner",
    body: "At 7",
  });
  expect(send.arguments).not.toContain("--gmail-no-send");
  expect(send.arguments).toEndWith(
    "gmail send --subject=Dinner --body=At 7 --to=anna@example.com"
  );
  expect(
    await tools.get("google_mail_send")!.approval!(
      {
        to: ["anna@example.com"],
        bcc: ["otto@example.com"],
        subject: "Dinner",
        body: "At 7",
        attachments: ["f1"],
      } as never,
      "token-1",
      undefined,
      async () => ({ path: "/unused", name: "plan.pdf" })
    )
  ).toBe(
    "Send mail to anna@example.com, otto@example.com: Dinner\n\nAt 7\n\nFiles: plan.pdf"
  );
  expect(answer.arguments).toEndWith(
    "gmail drafts create --subject=Dinner --body=--see you --to=anna@example.com,otto@example.com --thread-id=t1"
  );
  expect(
    (await call("google_mail_draft", { subject: "S", body: "B", draft: "d1" }))
      .arguments
  ).toEndWith("gmail drafts update --subject=S --body=B -- d1");
  // A value that looks like a flag stays a value.
  expect(
    (await call("google_mail_search", { query: "--force" })).arguments
  ).toEndWith("gmail search -- --force");
  expect(
    (
      await call("google_calendar_events", {
        from: "today",
        to: "tomorrow",
      })
    ).arguments
  ).toEndWith("calendar events --from=today --to=tomorrow --all");
  expect(
    (
      await call("google_calendar_create_event", {
        calendar: "primary",
        summary: "Dentist",
        from: "2026-10-28T09:00:00+01:00",
        to: "2026-10-28T10:00:00+01:00",
        guests: ["anna@example.com"],
        meet: true,
      })
    ).arguments
  ).toEndWith(
    "calendar create --summary=Dentist --from=2026-10-28T09:00:00+01:00 --to=2026-10-28T10:00:00+01:00 --attendees=anna@example.com --with-meet --send-updates=none -- primary"
  );
});

test("a calendar change emails the guests only with notify, after the person allows it", async () => {
  const create = tools.get("google_calendar_create_event")!;
  const event = {
    calendar: "primary",
    summary: "Trip",
    from: "2026-11-10",
    to: "2026-11-11",
    all_day: true,
    guests: ["anna@example.com"],
  };
  expect(await create.approval!(event as never, "token-1", undefined)).toBe(
    null
  );
  expect(
    await create.approval!(
      { ...event, notify: true } as never,
      "token-1",
      undefined
    )
  ).toBe("Invite anna@example.com by email to: Trip, 2026-11-10 to 2026-11-11");
  expect(
    (await call("google_calendar_create_event", { ...event, notify: true }))
      .arguments
  ).toEndWith(
    "--all-day --attendees=anna@example.com --send-updates=all -- primary"
  );
  expect(
    await tools.get("google_calendar_update_event")!.approval!(
      {
        calendar: "primary",
        event: "e1",
        summary: "Trip",
        notify: true,
      } as never,
      "token-1",
      undefined
    )
  ).toBe('Email the guests of event e1 about this change: {"summary":"Trip"}');
  expect(
    (
      await call("google_calendar_delete_event", {
        calendar: "primary",
        event: "e1",
        notify: true,
      })
    ).arguments
  ).toEndWith("calendar delete --force --send-updates=all -- primary e1");
});

test("a Doc comes from a Markdown file that gog reads, and gog's errors reach the agent without its notes", async () => {
  const created = await call("google_docs_create", {
    title: "Trip / plan",
    markdown: "# Trip",
  });
  expect(created.content).toBe("# Trip");
  expect(created.arguments).toMatch(
    /docs create --file=\S+Trip - plan\.md -- Trip \/ plan$/
  );
  await expect(call("google_drive_file", { file: "fail" })).rejects.toThrow(
    /^Google API error \(404\): not found$/
  );
});

test("a draft attaches workspace files under their own names", async () => {
  const stored = join(directory, "0190-a,b.zip");
  await Bun.write(stored, "zip");
  const file: FileOf = async (fileId) => {
    if (fileId !== "f1") {
      throw new Error(`There is no file ${fileId}.`);
    }
    return { path: stored, name: "a,b.zip" };
  };
  const answer = await call(
    "google_mail_draft",
    { subject: "S", body: "B", attachments: ["f1", "f1"] },
    file
  );
  expect(answer.content).toBe("a b.zip=zip;a b.zip=zip;");
  expect(answer.arguments).toMatch(
    /gmail drafts create --subject=S --body=B --attach=\S+\/0\/a b\.zip --attach=\S+\/1\/a b\.zip$/
  );
  await expect(
    call(
      "google_mail_draft",
      { subject: "S", body: "B", attachments: ["f2"] },
      file
    )
  ).rejects.toThrow("There is no file f2.");
  await expect(
    call("google_mail_draft", { subject: "S", body: "B", attachments: ["f1"] })
  ).rejects.toThrow("Only an agent in a thread can attach files.");
});

test("an attachment goes to the thread's channel under its own name", async () => {
  const saveAttachment = tools.get("google_mail_save_attachment")!;
  const saved = join(directory, "saved");
  expect(
    await saveAttachment.execute(
      { message: "m1", attachment: "a1", name: "invoice.pdf" } as never,
      "token-1",
      undefined,
      undefined,
      undefined,
      async (write) => ({ id: "f2", name: await write(saved) })
    )
  ).toEqual({ id: "f2", name: "invoice.pdf" });
  expect(await Bun.file(saved).text()).toEndWith(
    `gmail attachment --out=${saved} -- m1 a1\n`
  );
  await expect(
    saveAttachment.execute(
      { message: "m1", attachment: "a1", name: "invoice.pdf" } as never,
      "token-1",
      undefined
    )
  ).rejects.toThrow("Only an agent in a thread can save files.");
});

test("a workspace file goes to Drive under its own name, and a share sends no invitation", async () => {
  const stored = join(directory, "0190-report.zip");
  await Bun.write(stored, "zip");
  const file: FileOf = async () => ({ path: stored, name: "report.zip" });
  const uploaded = await call(
    "google_drive_upload",
    { file: "f1", folder: "folder-1" },
    file
  );
  expect(uploaded.arguments).toMatch(
    /drive upload --parent=folder-1 -- \S+\/0\/report\.zip$/
  );
  const shared = await call("google_drive_share", {
    file: "d1",
    to: "user",
    email: "anna@example.com",
  });
  expect(shared.arguments).toEndWith(
    "drive share --to=user --email=anna@example.com -- d1"
  );
  expect(shared.arguments).not.toContain("--notify");
});

test("a draft goes only as the person allowed it", async () => {
  const sendDraft = tools.get("google_mail_send_draft")!;
  // The approval shows the draft as gog writes it for people, without JSON or a send.
  const allowed = await sendDraft.approval!(
    { draft: "d1" } as never,
    "token-1",
    undefined
  );
  expect(allowed).toStartWith("Send this Gmail draft:\n\n");
  expect(allowed).toContain(
    "--color=never --gmail-no-send --no-input --enable-commands-exact="
  );
  expect(allowed).toContain(" gmail drafts get -- d1");
  const sent = (await sendDraft.execute(
    { draft: "d1" } as never,
    "token-1",
    undefined,
    undefined,
    allowed!
  )) as { arguments: string };
  expect(sent.arguments).not.toContain("--gmail-no-send");
  expect(sent.arguments).toEndWith("gmail drafts send -- d1");
  await expect(
    sendDraft.execute(
      { draft: "d1" } as never,
      "token-1",
      undefined,
      undefined,
      "Send this Gmail draft:\n\nTo: anna@example.com"
    )
  ).rejects.toThrow("The draft changed after the person allowed it");
});

test("mail intake reads the inbox in every tab and sent mail, and filters labels before body fetch and raw storage", async () => {
  const binary = join(directory, "watch-gog");
  const now = Date.now();
  const messages = [
    { id: "primary", labels: ["INBOX", "CATEGORY_PERSONAL"] },
    { id: "uncategorized", labels: ["INBOX"] },
    { id: "sent", labels: ["SENT"] },
    { id: "archived", labels: ["CATEGORY_PERSONAL"] },
    ...["PROMOTIONS", "SOCIAL", "UPDATES", "FORUMS"].map((category) => ({
      id: category,
      labels: ["INBOX", `CATEGORY_${category}`],
    })),
    ...["DRAFT", "SPAM", "TRASH"].map((label) => ({
      id: label,
      labels: ["INBOX", "SENT", label],
    })),
    { id: "missing" },
  ].map((message) => ({
    ...message,
    threadId: message.id,
    internalDateIso: new Date(now).toISOString(),
  }));
  await Bun.write(
    binary,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.includes("search")) {
  if (!args.at(-1).includes("{in:inbox in:sent}")) process.exit(2);
  console.log(JSON.stringify(${JSON.stringify(messages)}));
} else if (["primary", "uncategorized", "sent", "PROMOTIONS", "SOCIAL", "UPDATES", "FORUMS"].includes(args.at(-1))) {
  console.log(JSON.stringify({body: "Selected body"}));
} else process.exit(3);
`
  );
  await chmod(binary, 0o755);
  const records: unknown[] = [];
  const connector = googleConnector(binary);
  const items = await connector.watch!({
    call: async () => {
      throw new Error("No tool calls");
    },
    since: now - 1000,
    account: "alice@example.com",
    secret: async () => "token",
    seen: () => false,
    record: (_stage, data) => records.push(data),
  });
  expect(items.map((item) => item.id)).toEqual([
    "primary",
    "uncategorized",
    "sent",
    "PROMOTIONS",
    "SOCIAL",
    "UPDATES",
    "FORUMS",
  ]);
  expect(JSON.stringify(records)).not.toContain("archived");
  const observed = await connector.observations!(
    "google_mail_thread",
    {},
    {
      thread: {
        id: "thread",
        messages: messages.map((message) => ({
          ...message,
          internalDate: now,
          labelIds: message.labels,
          payload: {
            mimeType: "text/plain",
            body: { data: Buffer.from("Selected body").toString("base64url") },
          },
        })),
      },
    },
    { account: "alice@example.com", secret: async () => "token" }
  );
  expect(observed.map((item) => item.id)).toEqual([
    "primary",
    "uncategorized",
    "sent",
    "PROMOTIONS",
    "SOCIAL",
    "UPDATES",
    "FORUMS",
  ]);
  // Each body after the first waits 1.5 s, as the real connector does.
}, 15_000);

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
    "--json --results-only --no-input --wrap-untrusted --gmail-no-send --enable-commands-exact=gmail.search,"
  );
  expect(answer.arguments).not.toContain("gmail.send");
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
    "calendar create --summary=Dentist --from=2026-10-28T09:00:00+01:00 --to=2026-10-28T10:00:00+01:00 --attendees=anna@example.com --with-meet -- primary"
  );
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

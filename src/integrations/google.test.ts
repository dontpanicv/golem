import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleConnector } from "./google.ts";

const directory = await mkdtemp(join(tmpdir(), "golem-google-test-"));
const gog = join(directory, "gog");
// gog as Golem runs it: it answers with its arguments, its token, and the content of a file it reads; `fail` fails.
await Bun.write(
  gog,
  `#!/bin/sh
for argument; do
  case "$argument" in
    --file=*) content=$(cat "\${argument#--file=}") ;;
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

async function call(name: string, args: object) {
  return (await tools
    .get(name)!
    .execute(args as never, "token-1", undefined)) as {
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

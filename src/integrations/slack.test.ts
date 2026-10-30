import { afterAll, expect, test } from "bun:test";
import { chmod, exists, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slackConnector } from "./slack.ts";

const directory = await mkdtemp(join(tmpdir(), "golem-slack-test-"));
const slackcli = join(directory, "slackcli");
const SESSION =
  '{"default_workspace":"T1","workspaces":{"T1":{"workspace_id":"T1","workspace_name":"Family","auth_type":"browser"}}}';
// slackcli as Golem runs it: parse-curl keeps a session of the cURL on stdin; other commands answer with their
// arguments, their home, and the session there; `fail` fails as a `--json` command does.
await Bun.write(
  slackcli,
  `#!/bin/sh
config="$HOME/.config/slackcli/workspaces.json"
case "$*" in
  "auth parse-curl --login --secret-backend file")
    case "$(cat)" in
      curl*) printf '%s' '${SESSION}' > "$config" ;;
      *) printf '\\u274c Error: Failed to parse cURL command\\n   Could not find Slack workspace URL\\n\\nTip\\n' >&2; exit 1 ;;
    esac ;;
  *fail*) echo "- Searching" >&2; echo '{"error":{"code":"not_found","message":"Channel not found"}}' >&2; exit 1 ;;
  *) printf '{"arguments":"%s","home":"%s","token":"%s","session":%s}' "$*" "$HOME" "$SLACKCLI_TOKEN" "$(cat "$config")" ;;
esac
`
);
await chmod(slackcli, 0o755);
const connector = slackConnector(slackcli);
const tools = new Map(connector.tools.map((tool) => [tool.name, tool]));
afterAll(() => rm(directory, { recursive: true }));

test("a pasted cURL signs in, and names the credential after the workspace", async () => {
  expect(
    await connector.secretFrom!("curl 'https://family.slack.com/api'")
  ).toEqual({
    secret: SESSION,
    label: "Family",
  });
  await expect(connector.secretFrom!("hello")).rejects.toThrow(
    "Failed to parse cURL command Could not find Slack workspace URL"
  );
});

test("each tool runs slackcli with the session in a home of its own, which it removes after", async () => {
  Bun.env.SLACKCLI_TOKEN = "xoxb-of-this-machine";
  try {
    const answer = (await tools
      .get("slack_read")!
      .execute(
        { channel: "-general", thread: "1.2" } as never,
        SESSION,
        undefined
      )) as { arguments: string; home: string; token: string; session: object };
    // A value that looks like a flag stays a value, and this machine's token is not used.
    expect(answer.arguments).toBe(
      "conversations read --thread-ts=1.2 --json -- -general"
    );
    expect(answer.token).toBe("");
    expect(answer.session).toEqual(JSON.parse(SESSION));
    expect(await exists(answer.home)).toBe(false);
  } finally {
    Reflect.deleteProperty(Bun.env, "SLACKCLI_TOKEN");
  }
  await expect(
    tools
      .get("slack_search")!
      .execute({ query: "fail" } as never, SESSION, undefined)
  ).rejects.toThrow("Channel not found");
});

test("only slack_send acts as the person, and its approval shows what it sends", () => {
  expect(
    connector.tools.filter((tool) => tool.approval).map((tool) => tool.name)
  ).toEqual(["slack_send"]);
  expect(
    tools.get("slack_send")!.approval!(
      { to: "#family", text: "Dinner at 7", thread: "1.2" } as never,
      SESSION,
      undefined
    )
  ).toBe("Send on Slack to #family in a thread: Dinner at 7");
});

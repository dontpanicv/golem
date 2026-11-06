import { afterAll, expect, test } from "bun:test";
import { chmod, exists, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observedSlackMessage,
  type SlackMessage,
  slackConnector,
} from "./slack.ts";

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

test("source selection follows direct participation and the same thread, not channel activity", () => {
  const message: SlackMessage = {
    channel: { id: "C1", name: "work" },
    user: "U2",
    ts: "1.2",
    text: "The update",
    permalink: "https://example.slack.com/archives/C1/p1200000",
  };
  expect(observedSlackMessage(message, "U1", new Set())).toBeNull();
  expect(
    observedSlackMessage(
      { ...message, text: "<!channel> urgent" },
      "U1",
      new Set()
    )
  ).toBeNull();
  expect(
    observedSlackMessage({ ...message, user: "U1" }, "U1", new Set())?.fromOwner
  ).toBe(true);
  expect(
    observedSlackMessage(
      { ...message, text: "<@U1> please check" },
      "U1",
      new Set()
    )?.text
  ).toBe("@me please check");
  expect(
    observedSlackMessage(
      { ...message, channel: { id: "D1", is_im: true } },
      "U1",
      new Set()
    )?.group
  ).toBe(false);
  expect(
    observedSlackMessage(
      { ...message, channel: { id: "G1", is_mpim: true } },
      "U1",
      new Set()
    )?.group
  ).toBe(true);
  const followed = new Set(["C1/1.0"]);
  expect(
    observedSlackMessage({ ...message, thread_ts: "1.0" }, "U1", followed)?.chat
  ).toBe("C1/1.0");
  expect(
    observedSlackMessage({ ...message, thread_ts: "0.9" }, "U1", followed)
  ).toBeNull();
});

test("source reads keep the same personal Slack scope, including untagged participating-thread replies", async () => {
  const observed = slackConnector("unused");
  const source = {
    account: "Work",
    secret: async () =>
      JSON.stringify({
        default_workspace: "T1",
        workspaces: { T1: { user_id: "U1" } },
      }),
  };
  const channel = { id: "C1", name: "work" };
  const messages = [
    {
      channel,
      ts: "1.1",
      thread_ts: "1.1",
      user: "U1",
      text: "Please confirm",
      permalink: "https://example.com/1",
    },
    {
      channel,
      ts: "1.2",
      thread_ts: "1.1",
      user: "U2",
      text: "Confirmed",
      permalink: "https://example.com/2",
    },
    {
      channel,
      ts: "2.1",
      user: "U2",
      text: "<!channel> An unrelated announcement",
      permalink: "https://example.com/3",
    },
  ];
  const items = await observed.observations!(
    "slack_search",
    {},
    { matches: messages },
    source
  );
  expect(items.map((item) => item.text)).toEqual([
    "Please confirm",
    "Confirmed",
  ]);
  expect(
    await observed.observations!(
      "slack_draft",
      {},
      { matches: messages },
      source
    )
  ).toEqual([]);
});

test("source polling retains untagged thread replies and a partial thread cursor", async () => {
  const binary = join(directory, "watch-slackcli");
  await Bun.write(
    binary,
    `#!/usr/bin/env bun
const args=process.argv.slice(2);
const channel={id:"C1",name:"work",is_im:false,is_mpim:false};
const messages=[{ts:"1.1",user:"U1",text:"Please reply"},{ts:"1.2",user:"U2",text:"Here is the reply"},{ts:"1.3",user:"U2",text:"An unrelated message"}];
if(args[0]==="search") console.log(JSON.stringify({pages:1,matches:messages.map(m=>({...m,channel,permalink:"https://example.slack.com/archives/C1/p"+m.ts.replace(".","")+(m.ts==="1.2"?"?thread_ts=1.1":"")}))}));
else if(args[1]==="get") {const arg=args.find(a=>a.startsWith("--permalink="));if(arg.includes("p12"))throw new Error("Reply parent must come from its link");const ts=arg.endsWith("p11")?"1.1":arg.endsWith("p12")?"1.2":"1.3";console.log(JSON.stringify({message:{ts,thread_ts:ts==="1.3"?"1.3":"1.1"}}));}
else { const next=args.includes("--oldest=1.2"); console.log(JSON.stringify({messages:next?[{ts:"1.4",user:"U2",text:"And one more answer"}]:messages.slice(0,2),has_more:!next,next_oldest:next?"1.4":"1.2"})); }
`
  );
  await chmod(binary, 0o755);
  const watched = slackConnector(binary);
  let checkpoint: unknown = {};
  const coverage: boolean[] = [];
  const source = {
    since: 1000,
    account: "Work",
    seen: () => false,
    secret: async () =>
      JSON.stringify({
        default_workspace: "T1",
        workspaces: { T1: { user_id: "U1" } },
      }),
    call: async () => null,
    checkpoint: {
      get value() {
        return checkpoint;
      },
      save: (value: unknown) => {
        checkpoint = value;
      },
    },
    record: (stage: string, data: unknown) => {
      if (stage === "coverage") {
        coverage.push((data as { complete: boolean }).complete);
      }
    },
  };
  const first = await watched.watch!(source);
  expect(first.map((item) => item.text)).toEqual([
    "Please reply",
    "Here is the reply",
  ]);
  expect(coverage.at(-1)).toBe(false);
  const second = await watched.watch!(source);
  expect(second.map((item) => item.text)).toEqual(["And one more answer"]);
  expect(second[0]!.chat).toBe("C1/1.1");
  expect(coverage.at(-1)).toBe(true);
}, 15_000);

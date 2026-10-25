import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Context, Message } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import {
  type Connector,
  type ConnectorTool,
  Integrations,
} from "../integrations/integrations.ts";
import type { User } from "../platform/auth.ts";
import { Secrets } from "../platform/secrets.ts";
import { Routines } from "./routines.ts";

let golem: TestApp;
let alice: User;
let workspaceId: string;
let channelId: string;
/** The routines of the test, with a school connector; the app's own routines serve the agents' tools. */
let routines: Routines;
let integrations: Integrations;
/** The school's messages; the connector returns those after `since`. */
const school: { time: number; text: string }[] = [];
/** The secrets the connector got. */
const secretsSeen: string[] = [];
/** Whether the scripted agent fails, as when the LLM provider is down. */
let modelDown = false;
/** What each tool returned to the agent, in order. */
const toolResults: string[] = [];

const sinceParameters = Type.Object({ since: Type.Number() });
const schoolMessages: ConnectorTool<typeof sinceParameters> = {
  name: "school_messages",
  description: "Messages from the school after `since`, in Unix milliseconds.",
  parameters: sinceParameters,
  execute: async ({ since }, secret) => {
    secretsSeen.push(secret);
    return school.filter((message) => message.time > since);
  },
};
const connector: Connector = {
  id: "school",
  name: "School",
  secretLabel: "Password",
  tools: [schoolMessages],
};

/** Collects the school's new messages since the last run. */
const SCRIPT = `const since = load("since") ?? 0;
const messages = await tools.school_messages({ since });
if (messages.length) store("since", messages.at(-1).time);
return messages;`;

beforeAll(async () => {
  golem = await startTestApp();
  await golem.signIn("Alice", "alice@example.com");
  const { internalAdapter } = await golem.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(
    "alice@example.com"
  ))!;
  alice = { id: user.id, name: user.name, email: user.email };
  workspaceId = (await golem.app.workspaces.create(alice, "Family")).id;
  channelId = golem.app.workspaces.createChannel(
    workspaceId,
    alice,
    "school"
  ).id;
  integrations = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    [connector]
  );
  routines = new Routines(
    golem.app.database,
    golem.app.workspaces,
    integrations,
    golem.app.threads,
    golem.app.indexer
  );
  golem.faux.setResponses(Array.from({ length: 40 }, () => agent));
});
afterAll(() => golem.close());

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
}

/** A scripted agent: it answers routine runs from what they say, and calls the routine tools when asked. */
function agent(context: Context) {
  const last = context.messages.at(-1)!;
  const text = textOf(last);
  if (last.role === "toolResult") {
    toolResults.push(text);
    return fauxAssistantMessage("Done.");
  }
  const call = (name: string, args: Record<string, string>) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  if (text.includes("What its script found") && text.includes("exam")) {
    return modelDown
      ? fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "The model is down",
        })
      : fauxAssistantMessage("Anna has an exam on Monday.");
  }
  if (text.includes("What its script found") && text.includes("trip")) {
    return fauxAssistantMessage("The class goes on a trip on Friday.");
  }
  if (text.includes("What its script found")) {
    return fauxAssistantMessage("QUIET");
  }
  if (text.includes("failed at")) {
    return fauxAssistantMessage("I cannot read the school system.");
  }
  if (text.endsWith("Check the school every morning")) {
    return call("create_routine", {
      name: "School",
      schedule: "0 7 * * *",
      instructions: "Tell us about new messages.",
      script: "return [];",
    });
  }
  if (text.endsWith("Make a broken routine")) {
    return call("create_routine", {
      name: "Broken",
      schedule: "every morning",
      instructions: "Nothing.",
    });
  }
  if (text.endsWith("Test a script")) {
    return call("test_script", { script: 'text("hello"); return [1, 2];' });
  }
  if (text.endsWith("Summarize the channel")) {
    return call("set_channel_summary", { summary: "School news." });
  }
  return fauxAssistantMessage("Ok.");
}

function threadOf(threadId: string | null) {
  return golem.app.workspaces
    .threadsIn(workspaceId)
    .find((thread) => thread.id === threadId)!;
}

test("a script that finds nothing ends the run quietly, without the agent or a thread", async () => {
  integrations.addCredential(workspaceId, alice, "school", {
    label: "Anna",
    secret: "school-password",
  });
  const routine = routines.create(workspaceId, channelId, {
    id: crypto.randomUUID(),
    name: "Quiet school",
    schedule: "0 7 * * *",
    instructions: "Tell us about new messages.",
    script: SCRIPT,
    createdBy: alice.id,
  });
  const [run] = routines.tick(routine.nextRunAt!);
  expect(await run).toMatchObject({ outcome: "quiet", error: null });
  expect(secretsSeen).toEqual(["school-password"]);
  expect(routines.get(routine.id, alice).threadId).toBeNull();
  // The next run is the next day at 7:00, not the same time again.
  expect(routines.get(routine.id, alice).nextRunAt).toBeGreaterThan(
    routine.nextRunAt!
  );
  routines.delete(routine.id, alice);
});

test("the agent judges what the script found: quiet answers stay out of the thread", async () => {
  const routine = routines.create(workspaceId, channelId, {
    id: crypto.randomUUID(),
    name: "School",
    schedule: "0 7 * * *",
    instructions: "Tell us about new messages. Stay quiet about lunch menus.",
    script: SCRIPT,
    createdBy: alice.id,
  });
  school.push({ time: 1, text: "The lunch menu changed." });
  const quiet = await routines.tick(routine.nextRunAt!)[0]!;
  expect(quiet.outcome).toBe("quiet");
  const thread = threadOf(routines.get(routine.id, alice).threadId);
  expect(thread.title).toBe("School");
  expect(thread.channelId).toBe(channelId);
  expect((await golem.app.threads.messages(thread)).messages).toEqual([]);

  // The script remembers what it saw, so the next run gives the agent only the new message.
  school.push({ time: 2, text: "The class goes on a trip on Friday." });
  const posted = await routines.tick(
    routines.get(routine.id, alice).nextRunAt!
  )[0]!;
  expect(posted.outcome).toBe("posted");
  const { messages } = await golem.app.threads.messages(thread);
  expect(messages.map((message) => message.text)).toEqual([
    "The class goes on a trip on Friday.",
  ]);
  const { runs } = routines.inChannel(workspaceId, channelId, alice);
  expect(runs.slice(0, 2).map((run) => run.outcome)).toEqual([
    "posted",
    "quiet",
  ]);
  routines.delete(routine.id, alice);
});

test("what the script found waits for the next run when the agent cannot answer", async () => {
  const routine = routines.create(workspaceId, channelId, {
    id: crypto.randomUUID(),
    name: "Exams",
    schedule: "0 7 * * *",
    instructions: "Tell us about exams.",
    script: SCRIPT,
    createdBy: alice.id,
  });
  try {
    // The script starts at its own empty store, so it finds every message so far.
    school.length = 0;
    school.push({ time: 3, text: "Anna has an exam on Monday." });
    modelDown = true;
    const failed = await routines.tick(routine.nextRunAt!)[0]!;
    expect(failed).toMatchObject({
      outcome: "failed",
      error: "The model is down",
    });
    modelDown = false;
    const posted = await routines.tick(
      routines.get(routine.id, alice).nextRunAt!
    )[0]!;
    expect(posted.outcome).toBe("posted");
    const thread = threadOf(routines.get(routine.id, alice).threadId);
    expect(
      (await golem.app.threads.messages(thread)).messages.at(-1)?.text
    ).toBe("Anna has an exam on Monday.");
  } finally {
    modelDown = false;
    routines.delete(routine.id, alice);
  }
});

test("a failing script fails the run and goes to the agent to repair", async () => {
  const routine = routines.create(workspaceId, channelId, {
    id: crypto.randomUUID(),
    name: "Failing",
    schedule: "0 7 * * *",
    instructions: "Tell us about new messages.",
    script: 'throw new Error("The login page changed");',
    createdBy: alice.id,
  });
  const run = await routines.tick(routine.nextRunAt!)[0]!;
  expect(run).toMatchObject({
    outcome: "failed",
    error: "Error: The login page changed",
  });
  const thread = threadOf(routines.get(routine.id, alice).threadId);
  const { messages } = await golem.app.threads.messages(thread);
  expect(messages.map((message) => message.text)).toEqual([
    "I cannot read the school system.",
  ]);
  routines.delete(routine.id, alice);
});

test("a connector without a credential fails the script", async () => {
  const other = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    [{ ...connector, id: "school-2", name: "School 2" }]
  );
  const scripts = new Routines(
    golem.app.database,
    golem.app.workspaces,
    other,
    golem.app.threads,
    golem.app.indexer
  );
  const result = await scripts.test(workspaceId, SCRIPT);
  expect(result).toMatchObject({ ok: false });
  expect(!result.ok && result.error).toContain(
    "School 2 is not connected. Someone must add a credential"
  );
});

test("a paused routine does not run, and a routine runs once however many runs it missed", async () => {
  const routine = routines.create(workspaceId, channelId, {
    id: crypto.randomUUID(),
    name: "Paused",
    schedule: "*/5 * * * *",
    instructions: "Say hello.",
    createdBy: alice.id,
  });
  expect(routines.tick(routine.nextRunAt! - 1)).toEqual([]);
  routines.setEnabled(routine.id, alice, false);
  expect(routines.get(routine.id, alice).nextRunAt).toBeNull();
  expect(routines.tick(routine.nextRunAt! + 60 * 60_000)).toEqual([]);
  routines.setEnabled(routine.id, alice, true);
  const runs = routines.tick(Date.now() + 24 * 60 * 60_000);
  expect(runs).toHaveLength(1);
  // Without a script, the agent does the work on every run.
  expect((await runs[0])!.outcome).toBe("posted");
  routines.delete(routine.id, alice);
});

test("agents create routines, test scripts, and write the channel summary", async () => {
  const thread = await golem.app.threads.create(
    workspaceId,
    alice,
    channelId,
    "Check the school every morning"
  );
  const ref = () => threadOf(thread.id);
  const idle = () =>
    until(
      () => golem.app.threads.messages(ref()),
      (state) => !state.running && state.messages.at(-1)?.text === "Done."
    );
  await idle();
  expect(toolResults.at(-1)).toStartWith(
    "Created the routine.\nSchool (routine "
  );
  expect(toolResults.at(-1)).toContain("in #school");
  const [created] = golem.app.routines.inWorkspace(workspaceId);
  expect(created).toMatchObject({
    name: "School",
    channelId,
    schedule: "0 7 * * *",
    script: "return [];",
    enabled: true,
  });

  await golem.app.threads.send(thread.id, alice, "Make a broken routine");
  await until(
    () => golem.app.threads.messages(ref()),
    (state) => !state.running && state.messages.length === 4
  );
  expect(toolResults.at(-1)).toContain(
    'The schedule "every morning" is not a cron expression'
  );
  expect(golem.app.routines.inWorkspace(workspaceId)).toHaveLength(1);

  await golem.app.threads.send(thread.id, alice, "Test a script");
  await until(
    () => golem.app.threads.messages(ref()),
    (state) => !state.running && state.messages.length === 6
  );
  expect(toolResults.at(-1)).toBe(
    "The agent would get:\nhello\n[\n  1,\n  2\n]"
  );

  await golem.app.threads.send(thread.id, alice, "Summarize the channel");
  await until(
    () => golem.app.threads.messages(ref()),
    (state) => !state.running && state.messages.length === 8
  );
  expect(
    golem.app.workspaces
      .channelsIn(workspaceId)
      .find((channel) => channel.id === channelId)?.summary
  ).toBe("School news.");
});

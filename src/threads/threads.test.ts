import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Context, Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";

let golem: TestApp;
let alice: User;
let bob: User;
/** What each tool returned to the agent, in order. */
const toolResults: string[] = [];

beforeAll(async () => {
  golem = await startTestApp();
  alice = await person("Alice", "alice@example.com");
  bob = await person("Bob", "bob@example.com");
  // Threads run at the same time, so the model answers from what its conversation shows, not from a fixed order.
  golem.faux.setResponses(Array.from({ length: 40 }, () => agent));
});
afterAll(() => golem.close());

async function person(name: string, email: string): Promise<User> {
  await golem.signIn(name, email);
  const { internalAdapter } = await golem.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(email))!;
  return { id: user.id, name: user.name, email: user.email };
}

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
}

/** A scripted agent: one tool call for each request it knows, then a short answer after the tool result. */
function agent(context: Context) {
  const last = context.messages.at(-1)!;
  const text = textOf(last);
  if (last.role === "toolResult") {
    toolResults.push(text);
    return fauxAssistantMessage("Done.");
  }
  const call = (name: string, args: Record<string, string>) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  const relay = /\(thread ([\w-]+)\): (.*)$/s.exec(text);
  if (text.endsWith("Ask #food what's for dinner")) {
    return call("start_thread", {
      channel: "food",
      message: "What's for dinner?",
    });
  }
  if (relay?.[2] === "What's for dinner?") {
    return call("send_to_thread", { thread: relay[1]!, message: "Pasta" });
  }
  if (relay?.[2] === "Pasta") {
    // A third pass would let two agents talk forever.
    return call("send_to_thread", { thread: relay[1]!, message: "Thanks" });
  }
  if (text.endsWith("List the channels")) {
    return call("list_channels", {});
  }
  const other = /Tell thread ([\w-]+) hi$/.exec(text);
  if (other) {
    return call("send_to_thread", { thread: other[1]!, message: "Hi" });
  }
  return fauxAssistantMessage("Ok.");
}

async function idle(workspaceId: string, threadId: string) {
  const thread = golem.app.workspaces
    .threadsIn(workspaceId)
    .find((candidate) => candidate.id === threadId)!;
  return until(
    () => golem.app.threads.messages(thread),
    (state) => !state.running && state.messages.at(-1)?.text === "Done."
  );
}

test("an agent starts a thread in another channel, gets the answer back, and cannot keep the exchange going", async () => {
  const family = await golem.app.workspaces.create(alice, "Family");
  const food = golem.app.workspaces.createChannel(family.id, alice, "food");
  const general = golem.app.workspaces
    .channels(family.id, alice)
    .find((channel) => channel.name === "general")!;
  const asked = await golem.app.threads.create(
    family.id,
    alice,
    general.id,
    "Ask #food what's for dinner"
  );

  const started = await until(
    async () => golem.app.workspaces.channels(family.id, alice),
    (channels) =>
      channels.find((channel) => channel.id === food.id)!.threads.length === 1
  );
  const dinner = started.find((channel) => channel.id === food.id)!.threads[0]!;
  expect(dinner.title).toBe("What's for dinner?");

  const answered = await idle(family.id, dinner.id);
  expect(
    answered.messages.map((message) => [message.author, message.text])
  ).toEqual([
    ["Golem · Ask #food what's for dinner", "What's for dinner?"],
    ["Golem", "Done."],
  ]);
  const back = await until(
    () => idle(family.id, asked.id),
    (state) => state.messages.some((message) => message.text === "Pasta")
  );
  expect(
    back.messages.find((message) => message.text === "Pasta")?.author
  ).toBe("Golem · What's for dinner?");
  await until(
    async () => toolResults,
    (results) => results.some((result) => result.includes("already passed"))
  );
  expect(toolResults).toContainEqual(
    `Started "What's for dinner?" in #food (thread ${dinner.id}).`
  );
  expect(toolResults).toContainEqual(`Sent to "Ask #food what's for dinner".`);
});

test("an agent lists the channels of its workspace and cannot reach a thread of another workspace", async () => {
  const home = await golem.app.workspaces.create(alice, "Home");
  const work = await golem.app.workspaces.create(bob, "Work");
  const payroll = await golem.app.threads.create(
    work.id,
    bob,
    golem.app.workspaces.channels(work.id, bob)[0]!.id,
    "Payroll"
  );
  const general = golem.app.workspaces.channels(home.id, alice)[0]!;

  const listing = await golem.app.threads.create(
    home.id,
    alice,
    general.id,
    "List the channels"
  );
  await idle(home.id, listing.id);
  expect(toolResults).toContainEqual(
    expect.stringContaining(
      `#general\n- List the channels (thread ${listing.id}`
    )
  );

  const tell = await golem.app.threads.create(
    home.id,
    alice,
    general.id,
    `Tell thread ${payroll.id} hi`
  );
  await idle(home.id, tell.id);
  expect(toolResults).toContainEqual(
    expect.stringContaining(
      `There is no thread ${payroll.id} in this workspace.`
    )
  );
  const untouched = golem.app.workspaces.thread(payroll.id, bob);
  expect(
    (await golem.app.threads.messages(untouched)).messages.map(
      (message) => message.text
    )
  ).toEqual(["Payroll", "Ok."]);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Context } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";
import type { ChatSummary } from "../workspaces/workspaces.ts";

let golem: TestApp;
let alice: User;
let bob: User;
const toolResults: string[] = [];

beforeAll(async () => {
  golem = await startTestApp();
  await golem.signIn("Alice", "alice@example.com");
  await golem.signIn("Bob", "bob@example.com");
  const { internalAdapter } = await golem.app.auth.$context;
  alice = (await internalAdapter.findUserByEmail("alice@example.com"))!.user;
  bob = (await internalAdapter.findUserByEmail("bob@example.com"))!.user;
  golem.faux.setResponses(Array.from({ length: 200 }, () => agent));
});
afterAll(() => golem.close());

function agent(context: Context) {
  const last = context.messages.at(-1)!;
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("");
  const listing = /List chats (\{.*\})$/.exec(text);
  if (last.role === "user" && listing) {
    return fauxAssistantMessage(
      [fauxToolCall("list_chats", JSON.parse(listing[1]!))],
      { stopReason: "toolUse" }
    );
  }
  if (last.role === "toolResult") {
    toolResults.push(text);
  }
  return fauxAssistantMessage("Done.");
}

test("chat listing filters last activity, sorts across topics, includes settled chats, and enforces access", async () => {
  const home = await golem.app.workspaces.create(alice, "Chat lists");
  await golem.app.workspaces.addMember(home.id, alice, bob.email);
  const general = golem.app.workspaces.topics(home.id, alice)[0]!;
  const food = golem.app.workspaces.createTopic(home.id, alice, "food");
  const privateTopic = golem.app.workspaces.createTopic(
    home.id,
    alice,
    "private",
    true
  );
  const summaries: ChatSummary[] = [];
  for (const topic of [general, food, food, privateTopic]) {
    const chat = await golem.app.chats.create(
      home.id,
      alice,
      topic.id,
      "Hello"
    );
    await until(
      () => golem.app.chats.messages(golem.app.workspaces.chat(chat.id, alice)),
      (state) => !state.running && state.messages.length === 2
    );
    summaries.push(chat);
  }
  const [old, recent, newest, hidden] = summaries;
  const times = [
    "2026-11-01T00:00:00Z",
    "2026-11-04T00:00:00Z",
    "2026-11-06T00:00:00Z",
    "2026-11-05T00:00:00Z",
  ];
  for (const [index, chat] of summaries.entries()) {
    golem.app.database
      .query("UPDATE chat SET updated_at = ? WHERE id = ?")
      .run(Date.parse(times[index]!), chat.id);
  }
  golem.app.workspaces.setChatSettled(home.id, recent!.id, alice, true);
  await golem.app.chats.orchestrator(home.id, alice);
  await golem.app.chats.orchestrator(home.id, bob);

  expect(golem.app.chats.list(home.id, alice).map((chat) => chat.id)).toEqual([
    newest!.id,
    hidden!.id,
    recent!.id,
    old!.id,
  ]);
  expect(golem.app.chats.list(home.id, bob).map((chat) => chat.id)).toEqual([
    newest!.id,
    recent!.id,
    old!.id,
  ]);
  const filtered = golem.app.chats.list(home.id, alice, {
    topic: "#food",
    since: "2026-11-04",
    before: "2026-11-06",
    order: "oldest",
  });
  expect(filtered).toEqual([
    expect.objectContaining({
      id: recent!.id,
      topic: "food",
      topicId: food.id,
      settledAt: expect.any(Number),
    }),
  ]);
  expect(
    golem.app.chats
      .list(home.id, bob, {
        since: "2026-11-04T02:00:00+02:00",
        order: "oldest",
      })
      .map((chat) => chat.id)
  ).toEqual([recent!.id, newest!.id]);

  const token = await golem.signIn("Bob", bob.email);
  const base = `/api/v1/workspaces/${home.id}/chats`;
  const response = await golem.call(
    `${base}?topic=food&since=2026-11-04&order=oldest`,
    { token }
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { chats: ChatSummary[] };
  expect(body.chats.map((chat) => chat.id)).toEqual([recent!.id, newest!.id]);
  expect((await golem.call(`${base}?topic=private`, { token })).status).toBe(
    404
  );
  expect((await golem.call(`${base}?topic=missing`, { token })).status).toBe(
    404
  );
  expect((await golem.call(`${base}?since=invalid`, { token })).status).toBe(
    400
  );
  expect(
    (await golem.call(`${base}?since=2026-11-04T12:00:00`, { token })).status
  ).toBe(400);
  expect(
    (await golem.call(`${base}?since=2026-11-06&before=2026-11-04`, { token }))
      .status
  ).toBe(400);
  expect((await golem.call(`${base}?order=invalid`, { token })).status).toBe(
    400
  );
  expect((await golem.call(base)).status).toBe(401);
  const outsider = await golem.signIn("Eve", "eve@example.com");
  expect((await golem.call(base, { token: outsider })).status).toBe(404);
});

test("list_chats uses the person of the turn, including in a shared topic", async () => {
  const home = await golem.app.workspaces.create(alice, "Chat tool");
  await golem.app.workspaces.addMember(home.id, alice, bob.email);
  const general = golem.app.workspaces.topics(home.id, alice)[0]!;
  const privateTopic = golem.app.workspaces.createTopic(
    home.id,
    alice,
    "private",
    true
  );
  const hidden = await golem.app.chats.create(
    home.id,
    alice,
    privateTopic.id,
    "Hello"
  );
  await until(
    () => golem.app.chats.messages(golem.app.workspaces.chat(hidden.id, alice)),
    (state) => !state.running && state.messages.length === 2
  );
  const listed = await golem.app.chats.create(
    home.id,
    bob,
    general.id,
    'List chats {"order":"oldest"}'
  );
  await until(
    () => golem.app.chats.messages(golem.app.workspaces.chat(listed.id, alice)),
    (state) => !state.running && state.messages.at(-1)?.text === "Done."
  );
  const result = toolResults.at(-1)!;
  expect(result).toContain(`(chat:${listed.id}) in #general (`);
  expect(result).toContain(", open)");
  expect(result).not.toContain(hidden.id);
  await golem.app.chats.send(listed.id, bob, 'List chats {"topic":"private"}');
  await until(
    () => golem.app.chats.messages(golem.app.workspaces.chat(listed.id, alice)),
    (state) => !state.running && state.messages.length === 4
  );
  expect(toolResults.at(-1)).toContain("Not found");
  await golem.app.chats.send(
    listed.id,
    alice,
    'List chats {"topic":"private"}'
  );
  await until(
    () => golem.app.chats.messages(golem.app.workspaces.chat(listed.id, alice)),
    (state) => !state.running && state.messages.length === 6
  );
  expect(toolResults.at(-1)).toContain(`(chat:${hidden.id}) in #private (`);
});

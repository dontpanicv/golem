import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Context } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";
import type { ThreadSummary } from "../workspaces/workspaces.ts";

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
  const listing = /List threads (\{.*\})$/.exec(text);
  if (last.role === "user" && listing) {
    return fauxAssistantMessage(
      [fauxToolCall("list_threads", JSON.parse(listing[1]!))],
      { stopReason: "toolUse" }
    );
  }
  if (last.role === "toolResult") {
    toolResults.push(text);
  }
  return fauxAssistantMessage("Done.");
}

test("thread listing filters last activity, sorts across channels, includes settled threads, and enforces access", async () => {
  const home = await golem.app.workspaces.create(alice, "Thread lists");
  await golem.app.workspaces.addMember(home.id, alice, bob.email);
  const general = golem.app.workspaces.channels(home.id, alice)[0]!;
  const food = golem.app.workspaces.createChannel(home.id, alice, "food");
  const privateChannel = golem.app.workspaces.createChannel(
    home.id,
    alice,
    "private",
    true
  );
  const summaries: ThreadSummary[] = [];
  for (const channel of [general, food, food, privateChannel]) {
    const thread = await golem.app.threads.create(
      home.id,
      alice,
      channel.id,
      "Hello"
    );
    await until(
      () =>
        golem.app.threads.messages(
          golem.app.workspaces.thread(thread.id, alice)
        ),
      (state) => !state.running && state.messages.length === 2
    );
    summaries.push(thread);
  }
  const [old, recent, newest, hidden] = summaries;
  const times = [
    "2026-11-01T00:00:00Z",
    "2026-11-04T00:00:00Z",
    "2026-11-06T00:00:00Z",
    "2026-11-05T00:00:00Z",
  ];
  for (const [index, thread] of summaries.entries()) {
    golem.app.database
      .query("UPDATE thread SET updated_at = ? WHERE id = ?")
      .run(Date.parse(times[index]!), thread.id);
  }
  golem.app.workspaces.setThreadSettled(home.id, recent!.id, alice, true);
  await golem.app.threads.orchestrator(home.id, alice);
  await golem.app.threads.orchestrator(home.id, bob);

  expect(
    golem.app.threads.list(home.id, alice).map((thread) => thread.id)
  ).toEqual([newest!.id, hidden!.id, recent!.id, old!.id]);
  expect(
    golem.app.threads.list(home.id, bob).map((thread) => thread.id)
  ).toEqual([newest!.id, recent!.id, old!.id]);
  const filtered = golem.app.threads.list(home.id, alice, {
    channel: "#food",
    since: "2026-11-04",
    before: "2026-11-06",
    order: "oldest",
  });
  expect(filtered).toEqual([
    expect.objectContaining({
      id: recent!.id,
      channel: "food",
      channelId: food.id,
      settledAt: expect.any(Number),
    }),
  ]);
  expect(
    golem.app.threads
      .list(home.id, bob, {
        since: "2026-11-04T02:00:00+02:00",
        order: "oldest",
      })
      .map((thread) => thread.id)
  ).toEqual([recent!.id, newest!.id]);

  const token = await golem.signIn("Bob", bob.email);
  const base = `/api/v1/workspaces/${home.id}/threads`;
  const response = await golem.call(
    `${base}?channel=food&since=2026-11-04&order=oldest`,
    { token }
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { threads: ThreadSummary[] };
  expect(body.threads.map((thread) => thread.id)).toEqual([
    recent!.id,
    newest!.id,
  ]);
  expect((await golem.call(`${base}?channel=private`, { token })).status).toBe(
    404
  );
  expect((await golem.call(`${base}?channel=missing`, { token })).status).toBe(
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

test("list_threads uses the person of the turn, including in a shared channel", async () => {
  const home = await golem.app.workspaces.create(alice, "Thread tool");
  await golem.app.workspaces.addMember(home.id, alice, bob.email);
  const general = golem.app.workspaces.channels(home.id, alice)[0]!;
  const privateChannel = golem.app.workspaces.createChannel(
    home.id,
    alice,
    "private",
    true
  );
  const hidden = await golem.app.threads.create(
    home.id,
    alice,
    privateChannel.id,
    "Hello"
  );
  await until(
    () =>
      golem.app.threads.messages(golem.app.workspaces.thread(hidden.id, alice)),
    (state) => !state.running && state.messages.length === 2
  );
  const listed = await golem.app.threads.create(
    home.id,
    bob,
    general.id,
    'List threads {"order":"oldest"}'
  );
  await until(
    () =>
      golem.app.threads.messages(golem.app.workspaces.thread(listed.id, alice)),
    (state) => !state.running && state.messages.at(-1)?.text === "Done."
  );
  const result = toolResults.at(-1)!;
  expect(result).toContain(`(thread:${listed.id}) in #general (`);
  expect(result).toContain(", open)");
  expect(result).not.toContain(hidden.id);
  await golem.app.threads.send(
    listed.id,
    bob,
    'List threads {"channel":"private"}'
  );
  await until(
    () =>
      golem.app.threads.messages(golem.app.workspaces.thread(listed.id, alice)),
    (state) => !state.running && state.messages.length === 4
  );
  expect(toolResults.at(-1)).toContain("Not found");
  await golem.app.threads.send(
    listed.id,
    alice,
    'List threads {"channel":"private"}'
  );
  await until(
    () =>
      golem.app.threads.messages(golem.app.workspaces.thread(listed.id, alice)),
    (state) => !state.running && state.messages.length === 6
  );
  expect(toolResults.at(-1)).toContain(`(thread:${hidden.id}) in #private (`);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Context, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import {
  scriptCall,
  startTestApp,
  type TestApp,
  until,
} from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";
import type { ThreadRef, ThreadSummary } from "../workspaces/workspaces.ts";
import type { Artifact } from "./artifacts.ts";

let golem: TestApp;
let alice: User;
let eve: User;
let thread: ThreadRef & ThreadSummary;
/** What each tool returned to the agent, in order. */
const toolResults: string[] = [];
/** The tool call the scripted agent makes for the next message. */
let nextCall: { name: string; args: JsonObject } | null = null;

const POLL = `<!doctype html><html><head><title>Trip</title></head><body><button id="vote">15 Dec</button></body></html>`;

beforeAll(async () => {
  golem = await startTestApp();
  alice = await userOf("Alice", "alice@example.com");
  eve = await userOf("Eve", "eve@example.com");
  const workspaceId = (await golem.app.workspaces.create(alice, "Family")).id;
  const channel = golem.app.workspaces.createChannel(
    workspaceId,
    alice,
    "trips"
  );
  golem.faux.setResponses(Array.from({ length: 40 }, () => agent));
  const summary = await golem.app.threads.create(
    workspaceId,
    alice,
    channel.id,
    "Plan the trip"
  );
  thread = golem.app.workspaces.thread(summary.id, alice);
});
afterAll(() => golem.close());

async function userOf(name: string, email: string): Promise<User> {
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

/** A scripted agent: it makes the tool call the test set, then answers. */
function agent(context: Context) {
  const last = context.messages.at(-1)!;
  if (last.role === "toolResult") {
    toolResults.push(textOf(last));
    return fauxAssistantMessage("Done.");
  }
  const call = nextCall;
  nextCall = null;
  return call
    ? fauxAssistantMessage([scriptCall(call.name, call.args)], {
        stopReason: "toolUse",
      })
    : fauxAssistantMessage("Hello.");
}

/** Sends a message whose answer makes `name` with `args`, and returns what the tool returned. */
async function useTool(
  name: string,
  args: JsonObject,
  threadId = thread.id
): Promise<string> {
  const before = toolResults.length;
  nextCall = { name, args };
  await golem.app.threads.send(threadId, alice, `Use ${name}`);
  await until(
    async () => toolResults.length,
    (count) => count > before
  );
  return toolResults.at(-1)!;
}

function onlyArtifact(): Artifact {
  const artifacts = golem.app.artifacts.inPlace(
    thread.workspaceId,
    thread.channelId,
    alice
  );
  expect(artifacts).toHaveLength(1);
  return artifacts[0]!;
}

test("an agent makes an artifact in its thread, changes it, and reads and writes its data", async () => {
  expect(
    await useTool("artifacts_create", { title: "Trip dates", html: POLL })
  ).toContain("Made the artifact.");
  const artifact = onlyArtifact();
  expect(artifact).toMatchObject({
    channelId: thread.channelId,
    threadId: thread.id,
    title: "Trip dates",
    visibility: "members",
    visitors: 0,
    url: `http://golem.test/a/${artifact.id}`,
  });
  expect(artifact.id).toMatch(/^[a-z]+(-[a-z]+){3}$/);
  expect(new Set(artifact.id.split("-")).size).toBe(4);
  expect(toolResults.at(-1)).toContain(artifact.url);

  expect(
    await useTool("artifacts_edit", {
      id: artifact.id,
      find: "15 Dec",
      replace: "16 Dec",
    })
  ).toContain("Changed the artifact.");
  expect(golem.app.artifacts.html(artifact.id)).toContain("16 Dec");
  expect(
    await useTool("artifacts_edit", {
      id: artifact.id,
      find: "<",
      replace: "",
    })
  ).toContain("occurs");
  expect(
    await useTool("artifacts_update", { id: artifact.id, visibility: "public" })
  ).toContain("anyone with the link");

  expect(
    await useTool("artifacts_set_data", {
      id: artifact.id,
      key: "closed",
      value: false,
    })
  ).toContain("Saved the record.");
  expect(
    await useTool("artifacts_data", { id: artifact.id, prefix: "clo" })
  ).toContain('"key":"closed"');
  expect(await useTool("artifacts_list", {})).toContain(
    `[Plan the trip](thread:${thread.id})`
  );
  expect(await useTool("artifacts_read", { id: "missing" })).toContain(
    "There is no artifact missing"
  );
});

test("visitors keep their own data, read everyone's, and only members change shared data", () => {
  const { artifacts } = golem.app;
  const { id } = onlyArtifact();
  const grandma = { token: "grandma-browser" };
  const uncle = { token: "uncle-browser" };

  const me = artifacts.call(id, grandma, "me", {}) as {
    id: string;
    name: string | null;
    member: boolean;
  };
  expect(me).toMatchObject({ name: null, member: false });
  expect(me.id).toHaveLength(32);
  expect(me.id).not.toContain("grandma");
  expect(artifacts.call(id, grandma, "name", { name: " Grandma " })).toEqual({
    ...me,
    name: "Grandma",
  });
  artifacts.call(id, grandma, "set", {
    scope: "mine",
    key: "vote",
    value: ["15 Dec"],
  });
  artifacts.call(id, uncle, "set", {
    scope: "mine",
    key: "vote",
    value: ["16 Dec"],
  });
  artifacts.call(id, grandma, "set", {
    scope: "mine",
    key: "vote",
    value: ["16 Dec"],
  });
  expect(
    artifacts.call(id, grandma, "get", { scope: "mine", key: "vote" })
  ).toEqual(["16 Dec"]);
  expect(
    artifacts.call(id, uncle, "list", { scope: "mine", prefix: "" })
  ).toMatchObject([{ key: "vote", value: ["16 Dec"] }]);
  expect(
    artifacts.call(id, uncle, "get", { scope: "mine", key: "nothing" })
  ).toBeNull();
  const everyone = artifacts.call(id, uncle, "list", {
    scope: "everyone",
    prefix: "vo",
  }) as { name: string | null }[];
  expect(
    everyone.toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
  ).toMatchObject([
    { visitor: expect.any(String), name: null, key: "vote" },
    { visitor: me.id, name: "Grandma", key: "vote", value: ["16 Dec"] },
  ]);

  expect(
    artifacts.call(id, uncle, "get", { scope: "shared", key: "closed" })
  ).toBe(false);
  expect(() =>
    artifacts.call(id, uncle, "set", {
      scope: "shared",
      key: "closed",
      value: true,
    })
  ).toThrow("Only members change shared data");
  expect(() =>
    artifacts.call(id, { user: eve }, "delete", {
      scope: "shared",
      key: "closed",
    })
  ).toThrow("Only members change shared data");
  artifacts.call(id, { user: alice }, "set", {
    scope: "shared",
    key: "closed",
    value: true,
  });
  expect(artifacts.call(id, { user: alice }, "me", {})).toMatchObject({
    id: alice.id,
    name: "Alice",
    member: true,
  });
  // The author of a public artifact does not learn who of another workspace looks.
  const stranger = artifacts.call(id, { user: eve }, "me", {}) as {
    id: string;
  };
  expect(stranger).toMatchObject({ name: null, member: false });
  expect(stranger.id).toHaveLength(32);
  expect(stranger.id).not.toBe(eve.id);

  expect(() => artifacts.call(id, {}, "me", {})).toThrow("Open the link again");
  expect(() =>
    artifacts.call(id, uncle, "set", { scope: "mine", key: "", value: 1 })
  ).toThrow("A key is text");
  expect(() =>
    artifacts.call(id, uncle, "set", { scope: "theirs", key: "a", value: 1 })
  ).toThrow("Scope is mine, shared, or everyone");
  expect(() =>
    artifacts.call(id, uncle, "set", {
      scope: "mine",
      key: "big",
      value: "x".repeat(70_000),
    })
  ).toThrow("The value is too large");
  expect(() =>
    artifacts.call(id, uncle, "set", { scope: "mine", key: "a" })
  ).toThrow("Give a value");
  expect(onlyArtifact().visitors).toBe(4);
});

test("a members artifact is only for members, and people delete its records, its data, and it", () => {
  const { artifacts } = golem.app;
  const { id } = onlyArtifact();
  artifacts.setVisibility(id, alice, "members");
  expect(() => artifacts.open(id, { token: "grandma-browser" })).toThrow(
    "Sign in first"
  );
  expect(() => artifacts.open(id, { user: eve })).toThrow("Not found");
  expect(() => artifacts.get(id, eve)).toThrow("Not found");
  expect(() => artifacts.setVisibility(id, alice, "everyone")).toThrow(
    "Visibility is public or members"
  );
  expect(artifacts.open(id, { user: alice }).id).toBe(id);

  const shared = artifacts
    .dataFor(id, alice)
    .find((record) => record.visitor === null)!;
  artifacts.deleteRecordFor(id, alice, shared.id);
  expect(
    artifacts.dataFor(id, alice).some((record) => record.visitor === null)
  ).toBe(false);
  artifacts.clearData(id, alice);
  expect(artifacts.dataFor(id, alice)).toEqual([]);
  expect(onlyArtifact().visitors).toBe(0);
  artifacts.delete(id, alice);
  expect(
    artifacts.inPlace(thread.workspaceId, thread.channelId, alice)
  ).toEqual([]);
  expect(() => artifacts.open(id, { user: alice })).toThrow("Not found");
  // Nothing is removed: the artifact, its records, and its visitors stay, marked deleted.
  const kept = (table: string, column: string) =>
    golem.app.database
      .query(
        `SELECT count(*) AS count, count(deleted_at) AS deleted FROM ${table} WHERE ${column} = ?`
      )
      .get(id) as { count: number; deleted: number };
  expect(kept("artifact", "id")).toEqual({ count: 1, deleted: 1 });
  const records = kept("artifact_record", "artifact_id");
  expect(records.count).toBeGreaterThan(0);
  expect(records.deleted).toBe(records.count);
  const visitors = kept("artifact_visitor", "artifact_id");
  expect(visitors.count).toBeGreaterThan(0);
  expect(visitors.deleted).toBe(visitors.count);
  // The name stays taken, so that an old link never opens a new artifact.
  expect(
    golem.app.database
      .query("SELECT id FROM artifact_name WHERE id = ?")
      .get(id)
  ).toEqual({ id });
});

test("an artifact keeps a limited number of visitors and bytes, and gets them back when its data is cleared", () => {
  const { artifacts, database } = golem.app;
  const { id } = artifacts.create(thread, thread.channelId, {
    title: "Busy",
    html: "<p>Busy</p>",
    visibility: "public",
    requestKey: crypto.randomUUID(),
  });
  const insert = database.query(
    "INSERT INTO artifact_visitor (artifact_id, visitor, seen_at) VALUES (?, ?, 0)"
  );
  database.transaction(() => {
    for (let visitor = 0; visitor < 10_000; visitor += 1) {
      insert.run(id, `visitor-${visitor}`);
    }
  })();
  const late = { token: "late-browser" };
  expect(artifacts.call(id, late, "me", {})).toMatchObject({
    name: null,
    member: false,
  });
  const visitors = () =>
    artifacts
      .inPlace(thread.workspaceId, thread.channelId, alice)
      .find((artifact) => artifact.id === id)!.visitors;
  expect(visitors()).toBe(10_000);

  const value = "x".repeat(60 * 1024);
  const set = (key: string) =>
    artifacts.call(id, { user: alice }, "set", { scope: "shared", key, value });
  // 170 values of 60 KB fit in 10 MB; the next does not.
  for (let key = 0; key < 170; key += 1) {
    set(`k${key}`);
  }
  expect(() => set("k170")).toThrow("This artifact keeps no more data");
  expect(visitors()).toBe(10_000);

  artifacts.clearData(id, alice);
  expect(visitors()).toBe(0);
  set("k170");
  artifacts.call(id, late, "me", {});
  expect(visitors()).toBe(2);
  expect(artifacts.dataFor(id, alice)).toMatchObject([{ key: "k170" }]);
  // Nothing is removed: the cleared records stay, moved aside.
  expect(
    database
      .query(
        "SELECT count(*) AS count FROM artifact_record WHERE artifact_id = ? AND scope LIKE 'shared~%' AND deleted_at IS NOT NULL"
      )
      .get(id)
  ).toEqual({ count: 170 });
  artifacts.delete(id, alice);
});

test("the content policy and the runtime start every page, before any of the agent's HTML", () => {
  const { artifacts } = golem.app;
  const make = (html: string) =>
    artifacts.create(thread, thread.channelId, {
      title: "Page",
      html,
      requestKey: crypto.randomUUID(),
    }).id;
  const start = '<!doctype html><meta http-equiv="Content-Security-Policy"';
  for (const html of [
    POLL,
    "<!-- <head> --><script>x</script>",
    "<header><head></header><p>Hi</p>",
    "<!DOCTYPE html><p>Hi</p>",
    "<p>Hi</p>",
  ]) {
    const page = artifacts.content(make(html));
    expect(page).toStartWith(start);
    expect(page.match(/<!doctype/gi)).toHaveLength(1);
    expect(page).toContain("window.golem = golem");
    expect(page).toEndWith(html.replace(/^<!doctype html>/i, ""));
  }
  const policy = artifacts.content(make("<p>Hi</p>"));
  expect(policy).toContain("connect-src 'none'");
  expect(policy).not.toMatch(/(img|media)-src[^;]*https/);
  expect(policy).not.toMatch(/(script|style|font)-src[^;]*https:[ ;]/);
  expect(
    artifacts.create(thread, thread.channelId, {
      title: "Again",
      html: "<p>2</p>",
      requestKey: "same",
    }).id
  ).toBe(
    artifacts.create(thread, thread.channelId, {
      title: "Again",
      html: "<p>2</p>",
      requestKey: "same",
    }).id
  );
});

test("an artifact belongs to its channel: other threads see it after its thread is settled, until the channel is deleted", async () => {
  const { artifacts, threads, workspaces } = golem.app;
  const workspaceId = (await workspaces.create(alice, "Kitchen")).id;
  const recipes = workspaces.createChannel(workspaceId, alice, "recipes");
  const made = await threads.create(
    workspaceId,
    alice,
    recipes.id,
    "Save banana bread"
  );
  const banana = artifacts.create(
    workspaces.thread(made.id, alice),
    recipes.id,
    {
      title: "Banana bread",
      html: "<p>Bananas, flour, cardamom</p>",
      requestKey: crypto.randomUUID(),
    }
  );
  workspaces.setThreadSettled(workspaceId, made.id, alice, true);
  await threads.create(workspaceId, alice, recipes.id, "Make it vegan");
  expect(
    artifacts
      .inPlace(workspaceId, recipes.id, alice)
      .map((artifact) => artifact.id)
  ).toEqual([banana.id]);
  expect(artifacts.get(banana.id, alice).channelId).toBe(recipes.id);
  expect(() => artifacts.inPlace(workspaceId, recipes.id, eve)).toThrow(
    "Not found"
  );

  workspaces.deleteChannel(workspaceId, alice, recipes.id);
  expect(() => artifacts.get(banana.id, alice)).toThrow("Not found");
  expect(artifacts.inWorkspace(workspaceId)).toEqual([]);
});

test("the orchestrator's artifacts belong to the workspace, and an agent puts one in a channel it names", async () => {
  const { artifacts, threads } = golem.app;
  const orchestrator = await threads.orchestrator(thread.workspaceId, alice);
  await useTool(
    "artifacts_create",
    { title: "Chores", html: "<p>Dishes</p>" },
    orchestrator.id
  );
  const [chores] = artifacts.inPlace(thread.workspaceId, null, alice);
  expect(chores).toMatchObject({
    title: "Chores",
    channelId: null,
    threadId: orchestrator.id,
  });
  expect(toolResults.at(-1)).toContain("Made the artifact.");

  const named = await useTool(
    "artifacts_create",
    { title: "Packing list", html: "<p>Tent</p>", channel: "#trips" },
    orchestrator.id
  );
  expect(named).toContain("Made the artifact.");
  expect(
    artifacts
      .inPlace(thread.workspaceId, thread.channelId, alice)
      .map((artifact) => artifact.title)
  ).toContain("Packing list");
  expect(
    await useTool(
      "artifacts_create",
      { title: "Lost", html: "<p>?</p>", channel: "nowhere" },
      orchestrator.id
    )
  ).toContain("There is no channel #nowhere.");
  expect(await useTool("artifacts_list", {})).toContain("The workspace's");
});

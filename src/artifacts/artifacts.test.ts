import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Context, Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";
import type { ThreadRef } from "../workspaces/workspaces.ts";
import type { Artifact } from "./artifacts.ts";

let golem: TestApp;
let alice: User;
let eve: User;
let thread: ThreadRef;
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
    ? fauxAssistantMessage([fauxToolCall(call.name, call.args)], {
        stopReason: "toolUse",
      })
    : fauxAssistantMessage("Hello.");
}

/** Sends a message whose answer makes `name` with `args`, and returns what the tool returned. */
async function useTool(name: string, args: JsonObject): Promise<string> {
  const before = toolResults.length;
  nextCall = { name, args };
  await golem.app.threads.send(thread.id, alice, `Use ${name}`);
  await until(
    async () => toolResults.length,
    (count) => count > before
  );
  return toolResults.at(-1)!;
}

function onlyArtifact(): Artifact {
  const artifacts = golem.app.artifacts.inThread(thread.id, alice);
  expect(artifacts).toHaveLength(1);
  return artifacts[0]!;
}

test("an agent makes an artifact in its thread, changes it, and reads and writes its data", async () => {
  expect(
    await useTool("create_artifact", { title: "Trip dates", html: POLL })
  ).toContain("Made the artifact.");
  const artifact = onlyArtifact();
  expect(artifact).toMatchObject({
    threadId: thread.id,
    title: "Trip dates",
    visibility: "members",
    visitors: 0,
    url: `http://golem.test/a/${artifact.id}`,
  });
  expect(artifact.id).toMatch(/^[a-z]+-[a-z]+$/);
  expect(toolResults.at(-1)).toContain(artifact.url);

  expect(
    await useTool("edit_artifact", {
      id: artifact.id,
      find: "15 Dec",
      replace: "16 Dec",
    })
  ).toBe("Changed the artifact.");
  expect(golem.app.artifacts.html(artifact.id)).toContain("16 Dec");
  expect(
    await useTool("edit_artifact", {
      id: artifact.id,
      find: "<",
      replace: "",
    })
  ).toContain("occurs");
  expect(
    await useTool("update_artifact", { id: artifact.id, visibility: "public" })
  ).toContain("anyone with the link");

  expect(
    await useTool("set_artifact_data", {
      id: artifact.id,
      key: "closed",
      value: false,
    })
  ).toBe("Saved the record.");
  expect(
    await useTool("artifact_data", { id: artifact.id, prefix: "clo" })
  ).toContain('"key":"closed"');
  expect(await useTool("list_artifacts", {})).toContain(
    `[Plan the trip](thread:${thread.id})`
  );
  expect(await useTool("read_artifact", { id: "missing" })).toContain(
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
  expect(artifacts.inThread(thread.id, alice)).toEqual([]);
  // The name stays taken, so that an old link never opens a new artifact.
  expect(
    golem.app.database
      .query("SELECT id FROM artifact_name WHERE id = ?")
      .get(id)
  ).toEqual({ id });
});

test("the runtime goes at the top of the head, and after the doctype of a page without one", () => {
  const { artifacts } = golem.app;
  const make = (html: string) =>
    artifacts.create(thread, {
      title: "Page",
      html,
      requestKey: crypto.randomUUID(),
    }).id;
  const withHead = artifacts.content(make(POLL));
  expect(withHead).toStartWith(
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy"'
  );
  expect(withHead).toContain("connect-src 'none'");
  expect(withHead).toContain("window.golem = golem");
  expect(withHead).toEndWith(
    '<title>Trip</title></head><body><button id="vote">15 Dec</button></body></html>'
  );
  expect(artifacts.content(make("<!DOCTYPE html><p>Hi</p>"))).toMatch(
    /^<!DOCTYPE html><meta [^>]+><script>[\s\S]+<\/script><p>Hi<\/p>$/
  );
  expect(artifacts.content(make("<p>Hi</p>"))).toEndWith("</script><p>Hi</p>");
  expect(
    artifacts.create(thread, {
      title: "Again",
      html: "<p>2</p>",
      requestKey: "same",
    }).id
  ).toBe(
    artifacts.create(thread, {
      title: "Again",
      html: "<p>2</p>",
      requestKey: "same",
    }).id
  );
});

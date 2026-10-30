import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { clientJson } from "../src/app/http.ts";
import { startTestApp, type TestApp, until } from "./harness.ts";

let golem: TestApp;
let alice: string;
let bob: string;
let workspaceId: string;
let channelId: string;

beforeAll(async () => {
  golem = await startTestApp();
  alice = await golem.signIn("Alice", "alice@example.com");
  bob = await golem.signIn("Bob", "bob@example.com");
  // The first person to sign in starts Golem's one workspace.
  const [workspace] = (
    await body(await golem.call("/api/v1/me", { token: alice }))
  ).workspaces;
  workspaceId = workspace.id;
  const detail = await body(
    await golem.call(`/api/v1/workspaces/${workspaceId}`, { token: alice })
  );
  channelId = detail.channels[0].id;
});

afterAll(() => golem.close());

async function body(response: Response): Promise<any> {
  return await response.json();
}

/** Another workspace, which only the server makes, for a test of what stays apart. */
async function workspaceOf(token: string, name: string) {
  const { user } = await body(await golem.call("/api/v1/me", { token }));
  return golem.app.workspaces.create(user, name);
}

async function failure(response: Response) {
  return { status: response.status, ...(await body(response)) };
}

test("JSON for the apps has no half emoji and no line end that splits an event", () => {
  // Text cut inside an emoji, as a search result can be, and a caption with a line separator.
  const text = `donut!${"🥹".slice(0, 1)}… one\u2028two\u0085three\u2029`;
  const sent = clientJson({ text });
  expect(sent).not.toMatch(/[\u0085\u2028\u2029]|\\ud83e/);
  expect(JSON.parse(sent)).toEqual({
    text: "donut!\ufffd… one\u2028two\u0085three\u2029",
  });
});

test("a request body must be a JSON object", async () => {
  const post = (text: string) =>
    golem.handler(
      new Request(
        `http://golem.test/api/v1/workspaces/${workspaceId}/channels`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${alice}`,
            "content-type": "application/json",
          },
          body: text,
        }
      )
    );
  for (const text of ["{", "[1]", '"Family"', "null"]) {
    expect(await failure(await post(text))).toEqual({
      status: 400,
      error: "Send a JSON object",
    });
  }
  // An empty body is an empty object, so the missing field is the error.
  expect(await failure(await post(" "))).toEqual({
    status: 400,
    error: "Name is required",
  });
});

test("names and messages are checked before anything is stored", async () => {
  const base = `/api/v1/workspaces/${workspaceId}`;
  expect(
    await failure(
      await golem.call(`${base}/channels`, {
        token: alice,
        body: { name: "#!!" },
      })
    )
  ).toEqual({
    status: 400,
    error: "Use letters or numbers in the channel name",
  });
  expect(
    await failure(
      await golem.call(`${base}/channels`, {
        token: alice,
        body: { name: 42 },
      })
    )
  ).toEqual({ status: 400, error: "Name is required" });
  expect(
    await body(
      await golem.call(`${base}/channels`, {
        token: alice,
        body: { name: "#Weekend Plans" },
      })
    )
  ).toMatchObject({ name: "weekend-plans", threads: [] });
  expect(
    (
      await golem.call(`${base}/threads`, {
        token: alice,
        body: { channelId: "no-such-channel", text: "Hello" },
      })
    ).status
  ).toBe(404);
  expect(
    await failure(
      await golem.call(`${base}/threads`, {
        token: alice,
        body: { channelId, text: "   " },
      })
    )
  ).toEqual({ status: 400, error: "Message is required" });
  const { channels } = await body(await golem.call(base, { token: alice }));
  expect(
    channels.flatMap((channel: { threads: unknown[] }) => channel.threads)
  ).toEqual([]);
});

test("a long first line makes a short thread title", async () => {
  golem.faux.setResponses([fauxAssistantMessage("Noted.")]);
  const thread = await body(
    await golem.call(`/api/v1/workspaces/${workspaceId}/threads`, {
      token: alice,
      body: { channelId, text: `${"a".repeat(80)}\nsecond line` },
    })
  );
  expect(thread.title).toBe(`${"a".repeat(59)}…`);
  // The answer must use its own scripted response before the next test sets others.
  await until(
    async () =>
      body(await golem.call(`/api/v1/threads/${thread.id}`, { token: alice })),
    (state) => state.messages.length === 2 && !state.running
  );
});

test("a message sent again with the same request id, as the web app's outbox retries, stays one message", async () => {
  golem.faux.setResponses([
    fauxAssistantMessage("Noted."),
    fauxAssistantMessage("Got it."),
  ]);
  const thread = await body(
    await golem.call(`/api/v1/workspaces/${workspaceId}/threads`, {
      token: alice,
      body: { channelId, text: "Groceries" },
    })
  );
  const state = () =>
    golem.call(`/api/v1/threads/${thread.id}`, { token: alice }).then(body);
  await until(state, (now) => now.messages.length === 2 && !now.running);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sent = await golem.call(`/api/v1/threads/${thread.id}/messages`, {
      token: alice,
      body: { text: "And milk", requestId: "outbox-1" },
    });
    expect(sent.status).toBe(204);
  }
  const done = await until(
    state,
    (now) => now.messages.length >= 4 && !now.running
  );
  expect(
    done.messages.map((message: { text: string }) => message.text)
  ).toEqual(["Groceries", "Noted.", "And milk", "Got it."]);
});

test("members are listed, and only people who signed in once can be added once", async () => {
  const members = `/api/v1/workspaces/${workspaceId}/members`;
  expect((await golem.call(members, { token: bob })).status).toBe(404);
  expect(
    await failure(
      await golem.call(members, {
        token: alice,
        body: { email: "eve@example.com" },
      })
    )
  ).toEqual({ status: 400, error: "Nobody has signed up with that email yet" });
  expect(
    (
      await golem.call(members, {
        token: alice,
        body: { email: "bob@example.com" },
      })
    ).status
  ).toBe(200);
  expect(
    await failure(
      await golem.call(members, {
        token: alice,
        body: { email: "Bob@Example.com" },
      })
    )
  ).toEqual({ status: 409, error: "Bob is already a member" });
  expect(await body(await golem.call(members, { token: bob }))).toEqual([
    expect.objectContaining({
      name: "Alice",
      email: "alice@example.com",
      role: "owner",
    }),
    expect.objectContaining({
      name: "Bob",
      email: "bob@example.com",
      role: "member",
    }),
  ]);
  expect(
    await failure(
      await golem.call(members, {
        token: bob,
        body: { email: "alice@example.com" },
      })
    )
  ).toEqual({ status: 403, error: "Only an owner can do this" });
});

test("every member writes the workspace's facts, and nobody else reads them", async () => {
  const facts = `/api/v1/workspaces/${workspaceId}/facts`;
  expect(await body(await golem.call(facts, { token: alice }))).toEqual({
    text: "",
  });
  const text = "Bob: born 2 March 1990\nCottage: Lipno";
  expect(
    await body(
      await golem.call(facts, {
        token: bob,
        method: "PUT",
        body: { text: `  ${text}\n` },
      })
    )
  ).toEqual({ text });
  expect(await body(await golem.call(facts, { token: alice }))).toEqual({
    text,
  });
  expect(golem.app.workspaces.factsOf(workspaceId)).toBe(text);
  const eve = await golem.signIn("Eve", "eve@example.com");
  expect((await golem.call(facts, { token: eve })).status).toBe(404);
  expect(
    (
      await golem.call(facts, {
        token: alice,
        method: "PUT",
        body: { text: "x".repeat(20_001) },
      })
    ).status
  ).toBe(400);
});

test("an unknown integration is not found", async () => {
  const base = `/api/v1/workspaces/${workspaceId}/integrations/nope`;
  expect(
    (
      await golem.call(`${base}/credentials`, {
        token: alice,
        body: { label: "Key", secret: "x" },
      })
    ).status
  ).toBe(404);
});

test("routines of a channel are listed, paused, run, and deleted, and only members see them", async () => {
  const routine = golem.app.routines.create(workspaceId, channelId, {
    id: crypto.randomUUID(),
    name: "Morning",
    schedule: "0 7 * * *",
    instructions: "Say what is new.",
    script: "return [];",
    createdBy: "golem",
  });
  const list = `/api/v1/workspaces/${workspaceId}/channels/${channelId}/routines`;
  expect(await body(await golem.call(list, { token: alice }))).toMatchObject({
    routines: [
      {
        id: routine.id,
        channelId,
        name: "Morning",
        schedule: "0 7 * * *",
        instructions: "Say what is new.",
        script: "return [];",
        enabled: true,
        nextRunAt: routine.nextRunAt,
        threadId: null,
        lastRun: null,
      },
    ],
    runs: [],
  });
  const path = `/api/v1/routines/${routine.id}`;
  // Bob joined the workspace in an earlier test; Eve is not a member.
  const eve = await golem.signIn("Eve", "eve@example.com");
  expect((await golem.call(list, { token: eve })).status).toBe(404);
  expect(
    (await golem.call(path, { method: "DELETE", token: eve })).status
  ).toBe(404);

  expect(
    await body(
      await golem.call(path, {
        method: "PUT",
        token: alice,
        body: { enabled: false },
      })
    )
  ).toMatchObject({ enabled: false, nextRunAt: null });
  expect(
    (await golem.call(`${path}/runs`, { method: "POST", token: alice })).status
  ).toBe(202);
  const { runs } = await until(
    async () => body(await golem.call(list, { token: alice })),
    (state) => state.runs[0]?.outcome === "quiet"
  );
  expect(runs[0]).toMatchObject({
    routineId: routine.id,
    routineName: "Morning",
    error: null,
  });
  expect(
    (await golem.call(path, { method: "DELETE", token: alice })).status
  ).toBe(204);
  expect(
    (await golem.call(`${path}/runs`, { method: "POST", token: alice })).status
  ).toBe(404);
});

test("artifacts of a channel open with their runtime, run calls, and change and delete only for members", async () => {
  golem.faux.setResponses([fauxAssistantMessage("Here it is.")]);
  const thread = await body(
    await golem.call(`/api/v1/workspaces/${workspaceId}/threads`, {
      token: alice,
      body: { channelId, text: "Make a quiz" },
    })
  );
  const artifact = golem.app.artifacts.create(
    golem.app.workspaces
      .allThreadsIn(workspaceId)
      .find((t) => t.id === thread.id)!,
    channelId,
    { title: "Quiz", html: "<p>Q</p>", requestKey: "api-test" }
  );
  const eve = await golem.signIn("Eve", "eve@example.com");
  const path = `/api/v1/artifacts/${artifact.id}`;

  expect(
    await body(
      await golem.call(
        `/api/v1/workspaces/${workspaceId}/channels/${channelId}/artifacts`,
        { token: alice }
      )
    )
  ).toEqual({ artifacts: [artifact] });
  const rpc = (op: string, args: unknown, token = alice) =>
    golem.call(`${path}/rpc`, { token, body: { op, args } });
  expect(
    await body(await rpc("set", { scope: "mine", key: "score", value: 7 }))
  ).toEqual({ result: null });
  const opened = await body(await golem.call(path, { token: alice }));
  expect(opened.artifact).toMatchObject({ id: artifact.id, visitors: 1 });
  expect(opened.records).toMatchObject([
    { visitor: expect.any(String), name: "Alice", key: "score", value: 7 },
  ]);
  expect(opened.content).toContain("window.golem = golem");
  expect(opened.content).toEndWith("<p>Q</p>");

  for (const response of [
    await golem.call(path, { token: eve }),
    await rpc("me", {}, eve),
    await golem.call(path, { method: "DELETE", token: eve }),
  ]) {
    expect(response.status).toBe(404);
  }
  expect(
    await body(
      await golem.call(path, {
        method: "PUT",
        token: alice,
        body: { visibility: "public" },
      })
    )
  ).toMatchObject({ visibility: "public" });
  expect(await body(await rpc("me", {}, eve))).toMatchObject({
    // A visitor of another workspace is an id of this artifact only, with no name.
    result: { name: null, member: false },
  });
  expect(
    await failure(
      await rpc("set", { scope: "shared", key: "a", value: 1 }, eve)
    )
  ).toEqual({ status: 403, error: "Only members change shared data" });

  expect(
    (
      await golem.call(`${path}/records/${opened.records[0].id}`, {
        method: "DELETE",
        token: alice,
      })
    ).status
  ).toBe(204);
  expect(
    (await golem.call(`${path}/data`, { method: "DELETE", token: alice }))
      .status
  ).toBe(204);
  expect(
    (await body(await golem.call(path, { token: alice }))).records
  ).toEqual([]);
  expect(
    (await golem.call(path, { method: "DELETE", token: alice })).status
  ).toBe(204);
  expect((await golem.call(path, { token: alice })).status).toBe(404);
});

test("machines pair only over HTTPS, and only members see them", async () => {
  const base = `/api/v1/workspaces/${workspaceId}/machines`;
  expect(await body(await golem.call(base, { token: alice }))).toEqual({
    machines: [],
    pairing: null,
  });
  expect(
    await failure(
      await golem.call(`${base}/pairing`, { token: alice, body: {} })
    )
  ).toEqual({
    status: 409,
    error:
      "Machines pair over HTTPS: set base_url in config/golem.toml to Golem's https:// address",
  });
  const eve = await golem.signIn("Eve", "eve@example.com");
  expect((await golem.call(base, { token: eve })).status).toBe(404);
  expect((await golem.call("/hands/zzzzzz")).status).toBe(404);
  expect((await golem.call("/hands/zzzzzz/pair", { body: {} })).status).toBe(
    404
  );
  expect(
    (
      await golem.call("/hands/zzzzzz/pair", {
        body: { padding: "x".repeat(100_000) },
      })
    ).status
  ).toBe(413);
});

test("a JSON body over 1 MB gets 413 before the route reads it", async () => {
  const large = await golem.call(`/api/v1/workspaces/${workspaceId}/channels`, {
    token: alice,
    body: { name: "x".repeat(2 * 1024 ** 2) },
  });
  expect(await failure(large)).toEqual({
    status: 413,
    error: "The request is too large",
  });
});

test("thread events stream every change until the client leaves", async () => {
  golem.faux.setResponses([fauxAssistantMessage("Saturday works.")]);
  const thread = await body(
    await golem.call(`/api/v1/workspaces/${workspaceId}/threads`, {
      token: alice,
      body: { channelId, text: "Plan the cabin trip" },
    })
  );
  const events = await golem.call(`/api/v1/threads/${thread.id}/events`, {
    token: bob,
  });
  expect(events.headers.get("content-type")).toBe("text/event-stream");
  const stream = threadEvents(events);
  const first = await stream.until(
    (state) => state.messages.length === 2 && !state.running
  );
  expect(first.thread).toEqual(thread);

  golem.faux.setResponses([fauxAssistantMessage("Then Sunday.")]);
  const sent = await golem.call(`/api/v1/threads/${thread.id}/messages`, {
    token: bob,
    body: { text: "Saturday I work" },
  });
  expect(sent.status).toBe(204);
  const answered = await stream.until(
    (state) => state.messages.length === 4 && !state.running
  );
  expect(
    answered.messages.map((message: { author: string; text: string }) => [
      message.author,
      message.text,
    ])
  ).toEqual([
    ["Alice", "Plan the cabin trip"],
    ["Golem", "Saturday works."],
    ["Bob", "Saturday I work"],
    ["Golem", "Then Sunday."],
  ]);
  // A new message moves the thread up.
  const { channels } = await body(
    await golem.call(`/api/v1/workspaces/${workspaceId}`, { token: bob })
  );
  const general = channels.find(
    (channel: { id: string }) => channel.id === channelId
  );
  expect(general.threads[0].id).toBe(thread.id);
  expect(general.threads[0].updatedAt).toBeGreaterThan(thread.updatedAt);
  await stream.stop();

  expect(
    (await golem.call(`/api/v1/threads/${thread.id}/events`, { token: "nope" }))
      .status
  ).toBe(401);
});

test("a person who leaves a workspace stops getting its thread's events", async () => {
  golem.faux.setResponses([fauxAssistantMessage("Noted.")]);
  const leaving = await workspaceOf(alice, "Leaving");
  await golem.call(`/api/v1/workspaces/${leaving.id}/members`, {
    token: alice,
    body: { email: "bob@example.com" },
  });
  const { channels } = await body(
    await golem.call(`/api/v1/workspaces/${leaving.id}`, { token: alice })
  );
  const thread = await body(
    await golem.call(`/api/v1/workspaces/${leaving.id}/threads`, {
      token: alice,
      body: { channelId: channels[0].id, text: "A secret plan" },
    })
  );
  const stream = threadEvents(
    await golem.call(`/api/v1/threads/${thread.id}/events`, { token: bob })
  );
  await stream.until((state) => state.messages.length === 2 && !state.running);
  const bobId = (
    golem.app.database
      .query("SELECT id FROM user WHERE email = 'bob@example.com'")
      .get() as { id: string }
  ).id;
  golem.app.database
    .query("DELETE FROM member WHERE organizationId = ? AND userId = ?")
    .run(leaving.id, bobId);
  golem.faux.setResponses([fauxAssistantMessage("The new plan.")]);
  await golem.call(`/api/v1/threads/${thread.id}/messages`, {
    token: alice,
    body: { text: "The new secret" },
  });
  await expect(stream.until(() => true)).rejects.toThrow(
    "The event stream closed"
  );
});

test("the recall tool says when the workspace has nothing", async () => {
  golem.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("recall", { query: "zebra" }), {
      stopReason: "toolUse",
    }),
    (context) => {
      const result = context.messages.findLast(
        (message) => message.role === "toolResult"
      ) as ToolResultMessage | undefined;
      const text = result?.content[0];
      return fauxAssistantMessage(
        text?.type === "text" ? text.text : "no tool result"
      );
    },
  ]);
  const empty = await workspaceOf(alice, "Empty");
  const emptyDetail = await body(
    await golem.call(`/api/v1/workspaces/${empty.id}`, { token: alice })
  );
  const thread = await body(
    await golem.call(`/api/v1/workspaces/${empty.id}/threads`, {
      token: alice,
      body: { channelId: emptyDetail.channels[0].id, text: "Any zebras?" },
    })
  );
  const stream = threadEvents(
    await golem.call(`/api/v1/threads/${thread.id}/events`, { token: alice })
  );
  const done = await stream.until(
    (state) => !state.running && state.messages.length === 2
  );
  await stream.stop();
  expect(done.messages[1]).toMatchObject({
    agent: true,
    text: "Nothing found in this workspace.",
  });
});

test("the LLM login and logout answer with the provider status", async () => {
  // The faux provider has an API key and no device login.
  const login = await body(
    await golem.call("/api/v1/llm/login", { method: "POST", token: alice })
  );
  expect(login).toMatchObject({ connected: true, login: null });
  expect(login.error).toContain("does not support oauth login");
  expect(
    await body(
      await golem.call("/api/v1/llm/logout", { method: "POST", token: alice })
    )
  ).toMatchObject({ login: null, error: null });
  expect(
    await body(
      await golem.call("/api/v1/llm/model", {
        method: "PUT",
        token: alice,
        body: { model: golem.model.id },
      })
    )
  ).toMatchObject({ model: golem.model.id });
  expect(
    (await golem.call("/api/v1/llm/login", { method: "POST" })).status
  ).toBe(401);
});

/** Reads `event: thread` messages from a server-sent events response. */
function threadEvents(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async until(done: (state: any) => boolean): Promise<any> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end === -1) {
          const { value, done: closed } = await reader.read();
          if (closed) {
            throw new Error("The event stream closed");
          }
          buffer += decoder.decode(value, { stream: true });
          continue;
        }
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!block.startsWith("event: thread\n")) {
          continue;
        }
        const state = JSON.parse(block.slice(block.indexOf("data: ") + 6));
        if (done(state)) {
          return state;
        }
      }
    },
    stop: () => reader.cancel(),
  };
}

test("only an owner renames the workspace, and nobody makes or deletes one", async () => {
  const trip = await workspaceOf(alice, "Trip");
  const path = `/api/v1/workspaces/${trip.id}`;
  expect(
    (await golem.call(path, { token: bob, method: "PUT", body: { name: "X" } }))
      .status
  ).toBe(404);
  await golem.call(`${path}/members`, {
    token: alice,
    body: { email: "bob@example.com" },
  });
  expect(
    await failure(
      await golem.call(path, { token: bob, method: "PUT", body: { name: "X" } })
    )
  ).toEqual({ status: 403, error: "Only an owner can do this" });
  expect(
    await failure(
      await golem.call(path, {
        token: alice,
        method: "PUT",
        body: { name: " " },
      })
    )
  ).toEqual({ status: 400, error: "Name is required" });
  expect(
    await body(
      await golem.call(path, {
        token: alice,
        method: "PUT",
        body: { name: " Holiday " },
      })
    )
  ).toEqual({ id: trip.id, name: "Holiday", role: "owner" });
  expect(
    (await body(await golem.call("/api/v1/me", { token: bob }))).workspaces
  ).toContainEqual({ id: trip.id, name: "Holiday", role: "member" });

  // better-auth's own routes neither delete a workspace nor make another.
  await golem.call("/api/auth/organization/delete", {
    token: alice,
    body: { organizationId: trip.id },
  });
  expect((await golem.call(path, { token: alice })).status).toBe(200);
  const before = golem.app.workspaces.ids().length;
  await golem.call("/api/auth/organization/create", {
    token: alice,
    body: { name: "Another", slug: "another" },
  });
  await golem.call("/api/v1/workspaces", {
    token: alice,
    body: { name: "Another" },
  });
  expect(
    (await golem.call(path, { token: alice, method: "DELETE" })).status
  ).toBe(404);
  expect(golem.app.workspaces.ids()).toHaveLength(before);
});

test("a private channel, its threads, search results, and memory lines are its person's alone", async () => {
  golem.faux.setResponses([
    fauxAssistantMessage("Noted."),
    fauxAssistantMessage("Noted."),
  ]);
  const base = `/api/v1/workspaces/${workspaceId}`;
  // Bob is a member already when the earlier tests ran.
  await golem.call(`${base}/members`, {
    token: alice,
    body: { email: "bob@example.com" },
  });
  const orchestrators = await Promise.all(
    [alice, bob].map(async (token) =>
      body(await golem.call(`${base}/orchestrator`, { token }))
    )
  );
  const channel = await body(
    await golem.call(`${base}/channels`, {
      token: alice,
      body: { name: "surprise", private: true },
    })
  );
  expect(channel.ownerId).toBeString();
  const shared = await body(
    await golem.call(`${base}/channels`, {
      token: alice,
      body: { name: "together" },
    })
  );
  expect(shared.ownerId).toBeNull();
  const listed = async (token: string) =>
    (await body(await golem.call(base, { token }))).channels.map(
      (candidate: { name: string }) => candidate.name
    );
  expect(await listed(alice)).toContain("surprise");
  expect(await listed(bob)).not.toContain("surprise");
  expect(await listed(bob)).toContain("together");

  const thread = await body(
    await golem.call(`${base}/threads`, {
      token: alice,
      body: { channelId: channel.id, text: "A zebrafish tank for Bob" },
    })
  );
  expect(
    (await golem.call(`/api/v1/threads/${thread.id}`, { token: bob })).status
  ).toBe(404);
  expect(
    (
      await golem.call(`${base}/threads`, {
        token: bob,
        body: { channelId: channel.id, text: "Let me in" },
      })
    ).status
  ).toBe(404);
  expect(
    (
      await golem.call(`${base}/channels/${channel.id}`, {
        token: bob,
        method: "DELETE",
      })
    ).status
  ).toBe(404);

  await golem.app.indexer.scan(workspaceId);
  const found = async (token: string) =>
    (
      await body(await golem.call(`${base}/search?q=zebrafish`, { token }))
    ).results.map((result: { threadId: string }) => result.threadId);
  expect(await found(alice)).toContain(thread.id);
  expect(await found(bob)).toEqual([]);

  const linesOf = (orchestratorId: string) => {
    const path = join(
      golem.dataDirectory,
      "workspaces",
      workspaceId,
      "memories",
      `${orchestratorId}.sqlite`
    );
    if (!existsSync(path)) {
      return [];
    }
    const memory = new Database(path);
    const rows = memory
      .query("SELECT thread_id AS threadId FROM line WHERE level = 0")
      .all() as { threadId: string }[];
    memory.close();
    return rows.map((row) => row.threadId);
  };
  await until(
    async () => linesOf(orchestrators[0].id),
    (threads) => threads.includes(thread.id)
  );
  expect(linesOf(orchestrators[1].id)).not.toContain(thread.id);
});

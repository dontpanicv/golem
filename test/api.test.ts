import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
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
  const workspace = await body(
    await golem.call("/api/v1/workspaces", {
      token: alice,
      body: { name: "Family" },
    })
  );
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

async function failure(response: Response) {
  return { status: response.status, ...(await body(response)) };
}

test("a request body must be a JSON object", async () => {
  const post = (text: string) =>
    golem.handler(
      new Request("http://golem.test/api/v1/workspaces", {
        method: "POST",
        headers: {
          authorization: `Bearer ${alice}`,
          "content-type": "application/json",
        },
        body: text,
      })
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
});

test("an unknown integration is not found", async () => {
  const base = `/api/v1/workspaces/${workspaceId}/integrations/nope`;
  expect(
    (
      await golem.call(base, {
        method: "PUT",
        token: alice,
        body: { enabled: true },
      })
    ).status
  ).toBe(404);
  expect(
    (
      await golem.call(`${base}/credentials`, {
        token: alice,
        body: { label: "Key", secret: "x" },
      })
    ).status
  ).toBe(404);
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
  const empty = await body(
    await golem.call("/api/v1/workspaces", {
      token: alice,
      body: { name: "Empty" },
    })
  );
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

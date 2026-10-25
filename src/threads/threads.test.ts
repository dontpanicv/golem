import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Context, Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";
import { transcript } from "./pages.ts";

let golem: TestApp;
let alice: User;
let bob: User;
/** What each tool returned to the agent, in order. */
const toolResults: string[] = [];
/** The memory views that the orchestrator's compactions gave the agent. */
const memoryViews: string[] = [];

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
  memoryViews.push(
    ...context.messages
      .map(textOf)
      .filter((message) =>
        message.startsWith(
          "The conversation history before this point was compacted"
        )
      )
  );
  if (last.role === "toolResult") {
    toolResults.push(text);
    return fauxAssistantMessage("Done.");
  }
  const call = (name: string, args: Record<string, string>) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  const relay = /\]\(thread:([\w-]+)\): (.*)$/s.exec(text);
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
  const file = /^Alice: Read the file\nAttached: .* \(file ([\w-]+)\)$/.exec(
    text
  );
  if (file) {
    return call("read_file", { file: file[1]! });
  }
  const channelCommand = /(Create|Search|Delete) channels? (.+)$/.exec(text);
  if (channelCommand) {
    const [, verb, rest] = channelCommand;
    if (verb === "Create") {
      const [name, summary] = rest!.split(": ");
      return call("create_channel", { name: name!, summary: summary! });
    }
    return verb === "Search"
      ? call("search_channels", { query: rest! })
      : call("delete_channel", { channel: rest! });
  }
  if (text.endsWith("Zoom 0")) {
    return fauxAssistantMessage([fauxToolCall("zoom", { id: 0, n: 1 })], {
      stopReason: "toolUse",
    });
  }
  if (text.endsWith("List the channels")) {
    return call("list_channels", {});
  }
  const other = /Tell thread ([\w-]+) hi$/.exec(text);
  if (other) {
    return call("send_to_thread", { thread: other[1]!, message: "Hi" });
  }
  if (/^Alice: Turn on the lights\n\n\(Spoken in a conversation: /.test(text)) {
    return fauxAssistantMessage("Done.");
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
    [
      "Golem",
      `From [Ask #food what's for dinner](thread:${asked.id}): What's for dinner?`,
    ],
    ["Golem", "Done."],
  ]);
  const pasta = `From [What's for dinner?](thread:${dinner.id}): Pasta`;
  await until(
    () => idle(family.id, asked.id),
    (state) => state.messages.some((message) => message.text === pasta)
  );
  await until(
    async () => toolResults,
    (results) => results.some((result) => result.includes("already passed"))
  );
  expect(toolResults).toContainEqual(
    `Started [What's for dinner?](thread:${dinner.id}) in #food.`
  );
  expect(toolResults).toContainEqual(
    `Sent to [Ask #food what's for dinner](thread:${asked.id}).`
  );
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
      `#general\n- [List the channels](thread:${listing.id}) (`
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

/** Posts a multipart form, as the iOS app with a bearer token or the web with a session cookie. */
function postForm(
  path: string,
  form: FormData,
  headers: Record<string, string>
) {
  return golem.handler(
    new Request(`http://golem.test${path}`, {
      method: "POST",
      headers,
      body: form,
    })
  );
}

test("files attach to a new thread, a message, and the thread; the agent reads them; others cannot reach them", async () => {
  const token = await golem.signIn("Alice", "alice@example.com");
  const outsider = await golem.signIn("Bob", "bob@example.com");
  const home = await golem.app.workspaces.create(alice, "Files");
  const general = golem.app.workspaces.channels(home.id, alice)[0]!;

  const start = new FormData();
  start.set("channelId", general.id);
  start.set("text", "Read the file");
  start.append("files", new File(["Milk, eggs, bread"], "../shopping.txt"));
  const created = await postForm(
    `/api/v1/workspaces/${home.id}/threads`,
    start,
    { authorization: `Bearer ${token}` }
  );
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };
  await idle(home.id, id);
  expect(toolResults).toContain("Milk, eggs, bread");

  const page = new FormData();
  page.append("files", new File(["<script>alert(1)</script>"], "page.html"));
  const uploaded = await postForm(`/api/v1/threads/${id}/files`, page, {
    authorization: `Bearer ${token}`,
  });
  const message = new FormData();
  message.set("text", "");
  message.append("files", new File(["a photo"], "beach.png"));
  const sent = await postForm(`/w/${home.id}/t/${id}/messages`, message, {
    cookie: await golem.sessionCookie(token),
    origin: "http://golem.test",
  });
  expect(sent.status).toBe(200);

  const { files } = (await uploaded.json()) as {
    files: { id: string; name: string }[];
  };
  expect(files.map((file) => file.name)).toEqual(["shopping.txt", "page.html"]);
  const listed = await golem.call(`/api/v1/threads/${id}/files`, { token });
  expect(
    ((await listed.json()) as { files: { name: string }[] }).files.map(
      (file) => file.name
    )
  ).toEqual(["shopping.txt", "page.html", "beach.png"]);
  const thread = golem.app.workspaces.thread(id, alice);
  const { messages } = await golem.app.threads.messages(thread);
  // The agent may answer the last message meanwhile.
  expect(
    messages.slice(0, 3).map((m) => [m.text, m.files.map((f) => f.name)])
  ).toEqual([
    ["Read the file", ["shopping.txt"]],
    ["Done.", []],
    ["", ["beach.png"]],
  ]);

  const shopping = await golem.call(
    `/api/v1/threads/${id}/files/${files[0]!.id}`,
    { token }
  );
  expect(await shopping.text()).toBe("Milk, eggs, bread");
  expect(shopping.headers.get("content-disposition")).toBe(
    "inline; filename*=UTF-8''shopping.txt"
  );
  const html = await golem.call(`/api/v1/threads/${id}/files/${files[1]!.id}`, {
    token,
  });
  expect(html.headers.get("content-type")).toBe("application/octet-stream");
  expect(html.headers.get("content-disposition")).toStartWith("attachment");

  for (const path of [
    `/api/v1/threads/${id}/files`,
    `/api/v1/threads/${id}/files/${files[0]!.id}`,
  ]) {
    expect((await golem.call(path, { token: outsider })).status).toBe(404);
  }

  const pagePath = `/api/v1/threads/${id}/files/${files[1]!.id}`;
  const refused = await golem.call(pagePath, {
    token: outsider,
    method: "DELETE",
  });
  expect(refused.status).toBe(404);
  const deleted = await golem.call(pagePath, { token, method: "DELETE" });
  expect(
    ((await deleted.json()) as { files: { name: string }[] }).files.map(
      (file) => file.name
    )
  ).toEqual(["shopping.txt", "beach.png"]);
  expect((await golem.call(pagePath, { token })).status).toBe(404);
});

test("a composer with no file chosen starts a thread and sends a message", async () => {
  const token = await golem.signIn("Alice", "alice@example.com");
  const home = await golem.app.workspaces.create(alice, "No files");
  const general = golem.app.workspaces.channels(home.id, alice)[0]!;
  const cookie = await golem.sessionCookie(token);
  // What a browser posts for the composer: its empty file field is a part with `filename=""`.
  const post = (path: string, text: string) =>
    golem.handler(
      new Request(`http://golem.test${path}`, {
        method: "POST",
        headers: {
          cookie,
          origin: "http://golem.test",
          "content-type": "multipart/form-data; boundary=X",
        },
        body: `--X\r\nContent-Disposition: form-data; name="text"\r\n\r\n${text}\r\n--X\r\nContent-Disposition: form-data; name="files"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--X--\r\n`,
      })
    );

  const created = await post(`/w/${home.id}/c/${general.id}/threads`, "Hello");
  expect(created.status).toBe(303);
  const id = created.headers.get("location")!.split("/t/")[1]!;
  await until(
    () => golem.app.threads.messages(golem.app.workspaces.thread(id, alice)),
    (state) => !state.running && state.messages.length === 2
  );
  const sent = await post(`/w/${home.id}/t/${id}/messages`, "Thanks");
  expect(sent.status).toBe(200);

  const { messages } = await golem.app.threads.messages(
    golem.app.workspaces.thread(id, alice)
  );
  expect(messages.slice(0, 3).map((m) => [m.text, m.files.length])).toEqual([
    ["Hello", 0],
    ["Ok.", 0],
    ["Thanks", 0],
  ]);
});

test("a spoken message asks the agent for an answer to read aloud, and the transcript shows only the words", async () => {
  const token = await golem.signIn("Alice", "alice@example.com");
  const home = await golem.app.workspaces.create(alice, "Voice");
  const general = golem.app.workspaces.channels(home.id, alice)[0]!;
  const thread = await golem.app.threads.create(
    home.id,
    alice,
    general.id,
    "Hello"
  );
  const spoken = new FormData();
  spoken.set("text", "Turn on the lights");
  spoken.set("voice", "true");
  const sent = await postForm(`/api/v1/threads/${thread.id}/messages`, spoken, {
    authorization: `Bearer ${token}`,
  });
  expect(sent.status).toBe(204);

  const answered = await idle(home.id, thread.id);
  expect(answered.messages.map((message) => message.text)).toEqual([
    "Hello",
    "Ok.",
    "Turn on the lights",
    "Done.",
  ]);
});

test("the web shows each thread link in a message as a link into the workspace, and escapes the rest", () => {
  const html = transcript(
    {
      running: false,
      messages: [
        {
          id: "1",
          authorId: null,
          author: "Golem",
          agent: true,
          text: 'Started [Dinner <b>plan</b>](thread:abc-1) and [not a link](thread:"x) <i>',
          time: 0,
          failed: false,
          files: [],
          streaming: false,
        },
      ],
    },
    { id: "dinner", workspaceId: "family" }
  );
  expect(html).toContain(
    'Started <a class="thread-link" href="/w/family/t/abc-1">Dinner &lt;b&gt;plan&lt;/b&gt;</a> and [not a link](thread:&quot;x) &lt;i&gt;'
  );
});

test("a workspace has one orchestrator thread, which stays open and out of the channel lists", async () => {
  const family = await golem.app.workspaces.create(alice, "Orchestrated");
  const [first, again] = await Promise.all([
    golem.app.threads.orchestrator(family.id, alice),
    golem.app.threads.orchestrator(family.id, alice),
  ]);
  expect(again.id).toBe(first.id);
  expect((await golem.app.threads.orchestrator(family.id, alice)).id).toBe(
    first.id
  );
  expect(
    golem.app.workspaces.channels(family.id, alice).flatMap((c) => c.threads)
  ).toEqual([]);

  const token = await golem.signIn("Alice", "alice@example.com");
  const base = `/api/v1/workspaces/${family.id}`;
  expect(
    await (await golem.call(`${base}/orchestrator`, { token })).json()
  ).toEqual({
    id: first.id,
    channelId: first.channelId,
    title: "Golem",
    updatedAt: first.updatedAt,
    settledAt: null,
  });
  const settle = await golem.call(`${base}/threads/${first.id}/settled`, {
    token,
    body: { settled: true },
  });
  expect(settle.status).toBe(400);
  expect(await settle.json()).toEqual({ error: "This thread stays open" });
  const outsider = await golem.signIn("Bob", "bob@example.com");
  expect(
    (await golem.call(`${base}/orchestrator`, { token: outsider })).status
  ).toBe(404);
});

test("the orchestrator compacts into a view of its memory, and its agent zooms into a message", async () => {
  golem.faux.appendResponses(Array.from({ length: 40 }, () => agent));
  const home = await golem.app.workspaces.create(alice, "Remembering");
  const orchestrator = await golem.app.threads.orchestrator(home.id, alice);
  const said = async (text: string, messages: number) => {
    await golem.app.threads.send(orchestrator.id, alice, text);
    return until(
      () => golem.app.threads.messages(orchestrator),
      (state) => !state.running && state.messages.length === messages
    );
  };
  await said("The wifi password is on the fridge", 2);
  await said("Bring the tent", 4);
  await said("Call grandma on Sunday", 6);
  // About 62k tokens: the thread compacts after this turn, and the next request reads the memory.
  await said(`Here is the manual: ${"word ".repeat(50_000)}`, 8);
  const zoomed = await said("Zoom 0", 10);
  const view = memoryViews;
  expect(view[0]).toContain(
    "0+1|user: Alice: The wifi password is on the fridge\n1+1|golem: Ok.\n2+1|user: Alice: Bring the tent"
  );
  expect(view[0]).toContain("5+1|golem: Ok.");
  expect(view[0]).not.toContain("Here is the manual");
  // The transcript keeps the messages that the compaction took out of the model's context.
  expect(zoomed.messages[0]!.text).toBe("The wifi password is on the fridge");
  expect(zoomed.messages.at(-1)!.text).toBe("Done.");
  expect(toolResults).toContainEqual(
    expect.stringMatching(
      /^Message 0, \d{4}-\d\d-\d\d \d\d:\d\d UTC:\nuser: Alice: The wifi password is on the fridge$/
    )
  );
});

test("an agent creates, searches, and deletes channels, and keeps a channel that has threads or routines", async () => {
  const home = await golem.app.workspaces.create(alice, "Channels");
  const [general] = golem.app.workspaces.channels(home.id, alice);
  const asked = await golem.app.threads.create(
    home.id,
    alice,
    general!.id,
    "Hello"
  );
  await until(
    () =>
      golem.app.threads.messages(golem.app.workspaces.thread(asked.id, alice)),
    (state) => !state.running && state.messages.length === 2
  );
  const ask = async (text: string) => {
    const before = toolResults.length;
    await golem.app.threads.send(asked.id, alice, text);
    return (
      await until(
        async () => toolResults,
        () => toolResults.length > before
      )
    )
      .slice(before)
      .join("\n");
  };
  expect(await ask("Create channel Trips: Family trips and holidays")).toBe(
    "Created #trips."
  );
  const trips = golem.app.workspaces
    .channels(home.id, alice)
    .find((channel) => channel.name === "trips")!;
  expect(trips.summary).toBe("Family trips and holidays");

  expect(await ask("Search channels summer holidays")).toBe(
    "#trips: Family trips and holidays"
  );
  expect(await ask("Search channels dentist")).toBe(
    "No channel matches. list_channels shows them all."
  );
  expect(await ask("Create channel trips: Again")).toContain(
    "#trips already exists"
  );
  expect(await ask("Delete channel general")).toContain(
    "#general stays: The channel has 1 thread; only an empty channel can be deleted."
  );
  golem.app.routines.create(home.id, trips.id, {
    id: crypto.randomUUID(),
    name: "Flight prices",
    schedule: "0 8 * * *",
    instructions: "Check the flight prices",
    createdBy: "golem",
  });
  expect(await ask("Delete channel trips")).toContain(
    "#trips has the routines Flight prices. Delete them first."
  );
  const [routine] = golem.app.routines.inWorkspace(home.id);
  golem.app.routines.remove(home.id, routine!.id);
  expect(await ask("Delete channel #trips")).toBe("Deleted #trips.");
  expect(
    golem.app.workspaces.channels(home.id, alice).map((channel) => channel.name)
  ).toEqual(["general"]);
  expect(await ask("Delete channel trips")).toContain(
    "There is no channel #trips. list_channels shows the channels."
  );
});

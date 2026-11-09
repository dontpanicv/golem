import { afterEach, beforeEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Conversation } from "@earendil-works/pi-durable";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import { Browser } from "../browser/browser.ts";
import type { User } from "../platform/auth.ts";
import type { ChatRef, ChatSummary } from "../workspaces/workspaces.ts";
import { Chats } from "./chats.ts";

let golem: TestApp;
let alice: User;
let workspaceId: string;
let topicId: string;
let reopened: Chats | undefined;

beforeEach(async () => {
  golem = await startTestApp();
  await golem.signIn("Alice", "alice@example.com");
  const { internalAdapter } = await golem.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(
    "alice@example.com"
  ))!;
  alice = { id: user.id, name: user.name, email: user.email };
  workspaceId = (await golem.app.workspaces.create(alice, "Family")).id;
  topicId = golem.app.workspaces.topics(workspaceId, alice)[0]!.id;
  reopened = undefined;
  respond(() => fauxAssistantMessage("Done."));
});

afterEach(async () => {
  await reopened?.closeAll();
  await golem.close();
});

test("one hundred routine runs keep one chat and a bounded context, with the full transcript available", async () => {
  const contexts: string[] = [];
  respond((context) => {
    contexts.push(JSON.stringify(context));
    return fauxAssistantMessage("Saved.");
  });
  const chat = await golem.app.chats.startAgentChat(
    workspaceId,
    topicId,
    "Daily"
  );
  const conversation = await conversationOf(golem.app.chats, chat);
  for (let index = 0; index < 100; index += 1) {
    await instruct(
      golem.app.chats,
      chat,
      `Batch ${index}: ${"source ".repeat(100)}`,
      `run-${index}`
    );
    const context = JSON.stringify(
      (await conversation.context(BACKGROUND_CONTEXT)).messages
    );
    expect(context).toContain(`Batch ${index}:`);
    if (index) {
      expect(context).not.toContain(`Batch ${index - 1}:`);
    }
  }
  const sizes = contexts
    .filter((context) => context.includes("Batch "))
    .map((context) => context.length);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(1000);
  expect((await golem.app.chats.messages(chat)).messages).toHaveLength(100);
  expect(
    golem.app.workspaces
      .allChatsIn(workspaceId)
      .filter((candidate) => candidate.id === chat.id)
  ).toHaveLength(1);
}, 15_000);

test("recovery after the context boundary reuses it, and a settled input never resets a later run", async () => {
  const chat = await golem.app.chats.startAgentChat(
    workspaceId,
    topicId,
    "Daily"
  );
  const conversation = await conversationOf(golem.app.chats, chat);
  await conversation.submit(
    {
      type: "write",
      requestId: "run-one:context",
      entry: { kind: "golem.routine-context", head: "self" },
    },
    BACKGROUND_CONTEXT
  );
  await golem.app.chats.closeAll();
  reopened = reopenChats();
  await instruct(reopened, chat, "First batch", "run-one");
  await instruct(reopened, chat, "Second batch", "run-two");
  const before = await conversationOf(reopened, chat);
  const head = (await before.context(BACKGROUND_CONTEXT)).head!.id;
  await instruct(reopened, chat, "Must not become another input", "run-one");
  expect((await before.context(BACKGROUND_CONTEXT)).head!.id).toBe(head);
  expect(
    (await before.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(
      (entry) => entry.kind === "golem.routine-context"
    )
  ).toHaveLength(2);
  expect((await reopened.messages(chat)).messages).toHaveLength(2);
});

test("a run admitted by the previous server resumes without a new context boundary", async () => {
  const chat = await golem.app.chats.startAgentChat(
    workspaceId,
    topicId,
    "Existing run"
  );
  const conversation = await conversationOf(golem.app.chats, chat);
  await (
    await conversation.submit(
      {
        type: "input",
        content: "Original input",
        requestId: "existing",
        entry: {
          kind: "golem.task",
          data: {
            requesterId: alice.id,
            requesterName: alice.name,
            source: "routine",
          },
        },
      },
      BACKGROUND_CONTEXT
    )
  ).wait(BACKGROUND_CONTEXT);
  expect(
    await instruct(golem.app.chats, chat, "Not another input", "existing")
  ).toBe("Done.");
  expect((await conversation.context(BACKGROUND_CONTEXT)).head).toBeUndefined();
  expect((await golem.app.chats.messages(chat)).messages).toHaveLength(1);
});

test("a new routine waits for active work, and a person's concurrent message follows its admission", async () => {
  const held = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  let started = false;
  respond((context) => {
    if (
      JSON.stringify(context.messages.at(-1)).includes("Hold the first run")
    ) {
      started = true;
      return held.promise;
    }
    return fauxAssistantMessage("Done.");
  });
  const chat = await golem.app.chats.startAgentChat(
    workspaceId,
    topicId,
    "Daily"
  );
  const first = instruct(golem.app.chats, chat, "Hold the first run", "first");
  await until(async () => started, Boolean);
  const second = instruct(golem.app.chats, chat, "Second run", "second");
  const person = golem.app.chats.send(chat.id, alice, "A person follows up");
  await Bun.sleep(30);
  const conversation = await conversationOf(golem.app.chats, chat);
  expect(
    (
      await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)
    ).items.filter((entry) => entry.kind === "golem.routine-context")
  ).toHaveLength(1);
  held.resolve(fauxAssistantMessage("First completed."));
  expect(await first).toBe("First completed.");
  await second;
  await person;
  const state = await until(
    () => golem.app.chats.messages(chat),
    (value) => !value.running
  );
  expect(state.messages.map((message) => message.text)).toEqual([
    "First completed.",
    "Done.",
    "A person follows up",
    "Done.",
  ]);
});

test("a tool result survives a real session restart without repeating the file save", async () => {
  let stopped = false;
  let waiting = false;
  respond((context, options) => {
    const last = context.messages.at(-1)!;
    if (last.role === "toolResult") {
      if (stopped) {
        return fauxAssistantMessage("File saved.");
      }
      waiting = true;
      return new Promise<never>((_, reject) =>
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("Server stopped")),
          { once: true }
        )
      );
    }
    return fauxAssistantMessage(
      [
        fauxToolCall("save_file", {
          name: "Source.md",
          content: "The exact source.",
        }),
      ],
      { stopReason: "toolUse" }
    );
  });
  const chat = await golem.app.chats.startAgentChat(
    workspaceId,
    topicId,
    "Daily"
  );
  const running = instruct(
    golem.app.chats,
    chat,
    "Archive the source",
    "archive"
  ).catch(() => null);
  await until(async () => waiting, Boolean);
  const conversation = await conversationOf(golem.app.chats, chat);
  const head = (await conversation.context(BACKGROUND_CONTEXT)).head!.id;
  await golem.app.chats.closeAll();
  await running;
  stopped = true;
  reopened = reopenChats();
  expect(await instruct(reopened, chat, "Archive the source", "archive")).toBe(
    "File saved."
  );
  const recovered = await conversationOf(reopened, chat);
  expect((await recovered.context(BACKGROUND_CONTEXT)).head!.id).toBe(head);
  expect(await reopened.files({ workspaceId, topicId })).toHaveLength(1);
  expect((await reopened.messages(chat)).messages).toHaveLength(1);
});

test("tool-using routine answers are posted and notify, while reminders keep their earlier context", async () => {
  respond((context) =>
    context.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage("New item archived.")
      : fauxAssistantMessage([fauxToolCall("list_files", {})], {
          stopReason: "toolUse",
        })
  );
  const chat = await golem.app.chats.startAgentChat(
    workspaceId,
    topicId,
    "Daily"
  );
  expect(
    await instruct(golem.app.chats, chat, "Routine source", "routine")
  ).toBe("New item archived.");
  expect(
    golem.app.notifications.inbox(workspaceId, alice).notifications[0]?.text
  ).toBe("New item archived.");
  respond(() => fauxAssistantMessage("Reminder delivered."));
  await golem.app.chats.instruct(
    chat,
    "Reminder",
    "reminder",
    [],
    alice.id,
    "reminder"
  );
  const conversation = await conversationOf(golem.app.chats, chat);
  expect(
    JSON.stringify((await conversation.context(BACKGROUND_CONTEXT)).messages)
  ).toContain("Routine source");
});

test("an oversized routine input is refused before the provider is called", async () => {
  let calls = 0;
  respond(() => {
    calls += 1;
    return fauxAssistantMessage("Unexpected.");
  });
  const chat = await golem.app.chats.startAgentChat(
    workspaceId,
    topicId,
    "Daily"
  );
  await expect(
    instruct(golem.app.chats, chat, "source ".repeat(50_000), "oversized")
  ).rejects.toThrow("Input budget exceeded");
  expect(calls).toBe(0);
});

test("a long run compacts between complete tool rounds and keeps its source and final answer", async () => {
  let rounds = 0;
  let summaries = 0;
  const requests: number[] = [];
  respond((context) => {
    if (
      JSON.stringify(context).includes(
        "You are a context summarization assistant"
      )
    ) {
      summaries += 1;
      return fauxAssistantMessage(
        "Current run: inspect source-123. Completed file listing rounds. Continue with the next round. No previous run work is pending."
      );
    }
    requests.push(Buffer.byteLength(JSON.stringify(context)));
    rounds += 1;
    return rounds > 12
      ? fauxAssistantMessage("Source-123 checked.")
      : fauxAssistantMessage(
          [
            { type: "text", text: "Inspection detail. ".repeat(1700) },
            fauxToolCall("list_files", {}),
          ],
          { stopReason: "toolUse" }
        );
  });
  const chat = await golem.app.chats.startAgentChat(
    workspaceId,
    topicId,
    "Long run"
  );
  expect(
    await instruct(golem.app.chats, chat, "Inspect source-123", "long")
  ).toBe("Source-123 checked.");
  expect(summaries).toBeGreaterThan(0);
  expect(Math.max(...requests)).toBeLessThan(256 * 1024);
  const conversation = await conversationOf(golem.app.chats, chat);
  expect(
    (
      await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)
    ).items.some((entry) => entry.kind === "pi.compaction")
  ).toBe(true);
  expect((await golem.app.chats.messages(chat)).messages.at(-1)?.text).toBe(
    "Source-123 checked."
  );
}, 10_000);

function respond(response: FauxResponseFactory) {
  golem.faux.setResponses(Array.from({ length: 500 }, () => response));
}

function instruct(
  chats: Chats,
  chat: ChatSummary & ChatRef,
  text: string,
  requestId: string
) {
  return chats.instruct(chat, text, requestId, "everyone", alice.id, "routine");
}

function conversationOf(chats: Chats, chat: ChatRef): Promise<Conversation> {
  return (
    chats as unknown as {
      conversation: (chat: ChatRef) => Promise<Conversation>;
    }
  ).conversation(chat);
}

function reopenChats(): Chats {
  const { app } = golem;
  return new Chats(
    golem.dataDirectory,
    app.llm,
    app.workspaces,
    app.hands,
    app.integrations,
    app.artifacts,
    new Browser(),
    app.notifications,
    {
      changed: () => undefined,
      moved: () => undefined,
      merged: () => undefined,
      recall: async () => ({ results: [] }),
      tools: async () => [],
      automations: () => "",
      suggest: () => undefined,
      read: (path) => Bun.file(path).text(),
      picture: async () => null,
    }
  );
}

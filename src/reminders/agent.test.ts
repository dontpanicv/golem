import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Context, Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  scriptCall,
  startTestApp,
  type TestApp,
  until,
} from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";

let golem: TestApp;
let alice: User;

beforeAll(async () => {
  golem = await startTestApp();
  await golem.signIn("Alice", "alice@example.com");
  const { internalAdapter } = await golem.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(
    "alice@example.com"
  ))!;
  alice = { id: user.id, name: user.name, email: user.email };
  golem.faux.setResponses(Array.from({ length: 30 }, () => agent));
});
afterAll(() => golem.close());

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
}

function agent(context: Context) {
  const last = context.messages.at(-1)!;
  if (last.role === "toolResult") {
    return fauxAssistantMessage("Scheduled.");
  }
  if (textOf(last).endsWith("Delegate reminder")) {
    return fauxAssistantMessage(
      [fauxToolCall("start_thread", { message: "Remind me next year" })],
      { stopReason: "toolUse" }
    );
  }
  if (textOf(last).endsWith("Remind me next year")) {
    return fauxAssistantMessage(
      [
        scriptCall("reminders_create", {
          text: "Review the document",
          at: "2090-11-01T09:00:00+01:00",
          timeZone: "Europe/Prague",
        }),
      ],
      { stopReason: "toolUse" }
    );
  }
  return fauxAssistantMessage("Ok.");
}

test("the orchestrator and a channel thread can both schedule reminders in their workspace", async () => {
  const workspace = await golem.app.workspaces.create(alice, "Family");
  const orchestrator = await golem.app.threads.orchestrator(
    workspace.id,
    alice
  );
  const channel = golem.app.workspaces.channels(workspace.id, alice)[0]!;
  const thread = await golem.app.threads.create(
    workspace.id,
    alice,
    channel.id,
    "Remind me next year"
  );
  await golem.app.threads.send(orchestrator.id, alice, "Remind me next year");
  await until(
    () => golem.app.threads.messages(orchestrator),
    (state) => !state.running && state.messages.at(-1)?.text === "Scheduled."
  );
  await until(
    () =>
      golem.app.threads.messages(golem.app.workspaces.thread(thread.id, alice)),
    (state) => !state.running && state.messages.at(-1)?.text === "Scheduled."
  );
  expect(
    golem.app.reminders
      .list(workspace.id, alice)
      .map((reminder) => reminder.threadId)
      .sort()
  ).toEqual([orchestrator.id, thread.id].sort());
  await golem.app.threads.send(orchestrator.id, alice, "Delegate reminder");
  const delegated = await until(
    async () => golem.app.reminders.list(workspace.id, alice),
    (reminders) => reminders.length === 3
  );
  expect(delegated.every((reminder) => reminder.recipientId === alice.id)).toBe(
    true
  );
  const other = await golem.app.workspaces.create(alice, "Other");
  expect(golem.app.reminders.list(other.id, alice)).toEqual([]);
});

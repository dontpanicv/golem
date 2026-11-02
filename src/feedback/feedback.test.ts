import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { authDatabase } from "../../test/database.ts";
import type { User } from "../platform/auth.ts";
import { migrate } from "../platform/database.ts";
import { FeedbackReports } from "./feedback.ts";

const alice: User = { id: "alice", name: "Alice", email: "Alice@example.com" };
const bob: User = { id: "bob", name: "Bob", email: "bob@example.com" };
const thread = (id: string, conversationId: number, realm: string | null) => ({
  id,
  conversationId,
  realm,
});
const threads = [thread("shared", 1, null), thread("bobs", 2, "bob")];

function setup() {
  const database = authDatabase();
  migrate(database);
  const feedback = new FeedbackReports(
    database,
    {
      requireMember: () => ({ id: "home", name: "Home", role: "member" }),
      threadOf: (_workspaceId: string, conversationId: number) =>
        threads.find((each) => each.conversationId === conversationId) ?? null,
      threadsIn: (_workspaceId: string, realm: string | null) =>
        threads.filter((each) => each.realm === null || each.realm === realm),
    } as never,
    { requester: async () => bob } as never,
    "alice@example.com"
  );
  const report = (conversationId: number, taskId: string, summary: string) =>
    feedback
      .tools("home")[0]!
      .execute(
        { kind: "missing", tool: "phone_alarm", summary, detail: "No snooze" },
        { taskId, conversationId } as never,
        BACKGROUND_CONTEXT
      );
  return { feedback, report };
}

test("an agent reports once per call, and only the server's owner reads the reports", async () => {
  const { feedback, report } = setup();
  await report(1, "task-1", "Snooze");
  await report(1, "task-1", "Snooze");

  expect(feedback.list("home", alice)).toEqual([
    {
      id: expect.any(String),
      kind: "missing",
      tool: "phone_alarm",
      summary: "Snooze",
      detail: "No snooze",
      threadId: "shared",
      createdAt: expect.any(Number),
    },
  ]);
  expect(() => feedback.list("home", bob)).toThrow(
    "Only the server's owner reads feedback"
  );
});

test("the owner reads a report from another person's private thread without its link", async () => {
  const { feedback, report } = setup();
  await report(2, "task-2", "Private");

  expect(feedback.list("home", alice)[0]?.threadId).toBeNull();
});

test("a dismissed report leaves the list", async () => {
  const { feedback, report } = setup();
  await report(1, "task-1", "Snooze");
  const [first] = feedback.list("home", alice);

  expect(() => feedback.dismiss("home", bob, first!.id)).toThrow();
  feedback.dismiss("home", alice, first!.id);

  expect(feedback.list("home", alice)).toEqual([]);
  expect(() => feedback.dismiss("home", alice, first!.id)).toThrow("Not found");
});

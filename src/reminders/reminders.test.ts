import { expect, test } from "bun:test";
import type { User } from "../platform/auth.ts";
import { migrate, openDatabase } from "../platform/database.ts";
import type { Threads } from "../threads/threads.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";
import { Reminders } from "./reminders.ts";

const alice: User = { id: "alice", name: "Alice", email: "alice@example.com" };
const bob: User = { id: "bob", name: "Bob", email: "bob@example.com" };
const time = {
  at: "2090-11-01T09:00:00+01:00",
  timeZone: "Europe/Prague",
};

function setup(
  answer: (requestId: string) => string | null = () => "Done",
  requester: User | null = alice
) {
  const database = openDatabase(":memory:");
  migrate(database);
  const workspaces = {
    requireMember(workspaceId: string, user: User) {
      if (workspaceId !== "home" || user.id !== alice.id) {
        throw new Error("Not found");
      }
      return { id: "home", name: "Home", role: "owner" };
    },
    members(workspaceId: string, user: User) {
      if (workspaceId !== "home" || user.id !== alice.id) {
        throw new Error("Not found");
      }
      return [
        {
          userId: alice.id,
          name: alice.name,
          email: alice.email,
          role: "owner",
        },
      ];
    },
    agentMember() {
      return alice;
    },
    threadsIn(workspaceId: string) {
      return workspaceId === "home"
        ? [
            {
              id: "thread",
              workspaceId,
              channelId: "general",
              conversationId: 1,
              title: "Plans",
              updatedAt: 0,
              settledAt: null,
            },
          ]
        : [];
    },
  } as unknown as Pick<
    Workspaces,
    "agentMember" | "requireMember" | "members" | "threadsIn"
  >;
  const calls: string[] = [];
  const threads = {
    instruct: async (_thread: unknown, _text: string, requestId: string) => {
      calls.push(requestId);
      return answer(requestId);
    },
    requester: async () => requester,
  } as unknown as Pick<Threads, "instruct" | "requester">;
  return {
    database,
    workspaces,
    threads,
    reminders: new Reminders(database, workspaces, threads),
    calls,
  };
}

test("one-time reminders run once, also when the machine starts after their due time", async () => {
  const { database, workspaces, threads, reminders, calls } = setup();
  const reminder = reminders.create("home", alice, "thread", alice.id, {
    id: "first",
    text: "Review the document",
    ...time,
  });
  expect(reminder.dueAt).toBe(Date.UTC(2090, 10, 1, 8));
  expect(reminders.tick(reminder.dueAt - 1)).toEqual([]);
  const restarted = new Reminders(database, workspaces, threads);
  await Promise.all(restarted.tick(reminder.dueAt + 60_000));
  expect(calls).toEqual(["reminder:first:0"]);
  expect(reminders.get("home", alice, "first").deliveredAt).toBeNumber();
  expect(reminders.tick(reminder.dueAt + 120_000)).toEqual([]);
  database.close();
});

test("a failed reminder retries and a cancelled reminder stays quiet", async () => {
  let fail = true;
  const { database, reminders, calls } = setup(() => {
    if (fail) {
      fail = false;
      return null;
    }
    return "Done";
  });
  const first = reminders.create("home", alice, "thread", alice.id, {
    id: "retry",
    text: "Call grandma",
    ...time,
  });
  const second = reminders.create("home", alice, "thread", alice.id, {
    id: "cancel",
    text: "Buy milk",
    ...time,
  });
  reminders.cancel("home", alice, second.id);
  await Promise.all(reminders.tick(first.dueAt));
  const pending = reminders.get("home", alice, first.id);
  expect(pending.attempts).toBe(1);
  expect(pending.deliveredAt).toBeNull();
  await Promise.all(reminders.tick(pending.nextAttemptAt));
  expect(reminders.get("home", alice, first.id).deliveredAt).toBeNumber();
  expect(calls).toEqual(["reminder:retry:0", "reminder:retry:1"]);
  database.close();
});

test("reminders stay in their workspace and reject a wrong time-zone offset", () => {
  const { database, reminders } = setup();
  expect(reminders.tools("home").map((tool) => tool.name)).toEqual([
    "create_reminder",
    "list_reminders",
    "update_reminder",
    "cancel_reminder",
  ]);
  expect(() =>
    reminders.create("home", alice, "thread", alice.id, {
      id: "wrong-zone",
      text: "Call grandma",
      at: "2090-11-01T09:00:00+02:00",
      timeZone: "Europe/Prague",
    })
  ).toThrow("UTC offset");
  expect(() =>
    reminders.create("home", alice, "thread", bob.id, {
      id: "wrong-person",
      text: "Call grandma",
      ...time,
    })
  ).toThrow("Not found");
  expect(() => reminders.list("other", alice)).toThrow("Not found");
  expect(() => reminders.get("home", bob, "wrong-person")).toThrow("Not found");
  database.close();
});

test("the agent tool creates a workspace reminder for the person who asked", async () => {
  const { database, reminders } = setup();
  const tool = reminders
    .tools("home")
    .find((candidate) => candidate.name === "create_reminder")!;
  const result = await tool.execute(
    { text: "Review the document", ...time },
    { conversationId: 1, taskId: 3 } as never,
    {} as never
  );
  expect(result.output?.[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("01/11/2090, 09:00 Europe/Prague"),
  });
  const [reminder] = reminders.list("home", alice);
  expect(reminder).toMatchObject({
    threadId: "thread",
    recipientId: alice.id,
    text: "Review the document",
  });
  const update = reminders
    .tools("home")
    .find((candidate) => candidate.name === "update_reminder")!;
  await update.execute(
    {
      reminder: reminder!.id,
      text: "Review the new document",
      at: "2091-11-01T09:00:00+01:00",
      timeZone: "Europe/Prague",
    },
    { conversationId: 1, taskId: 4 } as never,
    {} as never
  );
  const cancel = reminders
    .tools("home")
    .find((candidate) => candidate.name === "cancel_reminder")!;
  await cancel.execute(
    { reminder: reminder!.id },
    { conversationId: 1, taskId: 5 } as never,
    {} as never
  );
  expect(reminders.get("home", alice, reminder!.id)).toMatchObject({
    text: "Review the new document",
    cancelledAt: expect.any(Number),
  });
  database.close();
});

test("an agent without a current person can name a workspace recipient", async () => {
  const { database, reminders } = setup(() => "Done", null);
  const tool = reminders
    .tools("home")
    .find((candidate) => candidate.name === "create_reminder")!;
  await expect(
    tool.execute(
      { text: "Review the document", ...time },
      { conversationId: 1, taskId: 4 } as never,
      {} as never
    )
  ).rejects.toThrow("Name exactly one member");
  await tool.execute(
    { text: "Review the document", recipient: "Alice", ...time },
    { conversationId: 1, taskId: 5 } as never,
    {} as never
  );
  expect(reminders.list("home", alice)).toHaveLength(1);
  database.close();
});

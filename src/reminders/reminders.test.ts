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
  const threadsOf = (workspaceId: string) =>
    workspaceId === "home"
      ? [
          {
            id: "thread",
            workspaceId,
            channelId: "general",
            conversationId: 1,
            title: "Plans",
            updatedAt: 0,
            settledAt: null,
            ownerId: null,
            realm: null,
          },
        ]
      : [];
  const workspaces = {
    requireMember(workspaceId: string, user: User) {
      if (workspaceId !== "home" || ![alice.id, bob.id].includes(user.id)) {
        throw new Error("Not found");
      }
      return { id: "home", name: "Home", role: "owner" };
    },
    members(workspaceId: string, user: User) {
      if (workspaceId !== "home" || ![alice.id, bob.id].includes(user.id)) {
        throw new Error("Not found");
      }
      return [
        {
          userId: alice.id,
          name: alice.name,
          email: alice.email,
          role: "owner",
        },
        { userId: bob.id, name: bob.name, email: bob.email, role: "member" },
      ];
    },
    agentMember() {
      return alice;
    },
    threadsIn: (workspaceId: string) => threadsOf(workspaceId),
    allThreadsIn: (workspaceId: string) => threadsOf(workspaceId),
    threadOf: (workspaceId: string, conversationId: number) =>
      threadsOf(workspaceId).find(
        (thread) => thread.conversationId === conversationId
      ) ?? null,
  } as unknown as Pick<
    Workspaces,
    | "agentMember"
    | "allThreadsIn"
    | "requireMember"
    | "members"
    | "threadOf"
    | "threadsIn"
  >;
  const calls: string[] = [];
  const requesters: (string | null)[] = [];
  const asking = { requester };
  const threads = {
    instruct: async (
      _thread: unknown,
      _text: string,
      requestId: string,
      _notify: unknown,
      requesterId: string | null
    ) => {
      calls.push(requestId);
      requesters.push(requesterId);
      return answer(requestId);
    },
    requester: async () => asking.requester,
    realm: async () => null,
  } as unknown as Pick<Threads, "instruct" | "realm" | "requester">;
  return {
    database,
    workspaces,
    threads,
    reminders: new Reminders(database, workspaces, threads),
    calls,
    requesters,
    asking,
  };
}

test("one-time reminders run once, also when the machine starts after their due time", async () => {
  const { database, workspaces, threads, reminders, calls } = setup();
  const reminder = reminders.create("home", alice, "thread", alice.id, {
    id: "first",
    createdBy: alice.id,
    text: "Review the document",
    ...time,
  });
  expect(reminder.dueAt).toBe(Date.UTC(2090, 10, 1, 8));
  expect(reminders.tick(reminder.dueAt - 1)).toEqual([]);
  const restarted = new Reminders(database, workspaces, threads);
  await Promise.all(restarted.tick(reminder.dueAt + 60_000));
  expect(calls).toEqual(["reminder:first:0"]);
  expect(reminders.get("home", alice, null, "first").deliveredAt).toBeNumber();
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
    createdBy: alice.id,
    text: "Call grandma",
    ...time,
  });
  const second = reminders.create("home", alice, "thread", alice.id, {
    id: "cancel",
    createdBy: alice.id,
    text: "Buy milk",
    ...time,
  });
  reminders.cancel("home", alice, null, second.id);
  await Promise.all(reminders.tick(first.dueAt));
  const pending = reminders.get("home", alice, null, first.id);
  expect(pending.attempts).toBe(1);
  expect(pending.deliveredAt).toBeNull();
  await Promise.all(reminders.tick(pending.nextAttemptAt));
  expect(reminders.get("home", alice, null, first.id).deliveredAt).toBeNumber();
  expect(calls).toEqual(["reminder:retry:0", "reminder:retry:1"]);
  database.close();
});

test("reminders stay in their workspace and reject a wrong time-zone offset", () => {
  const { database, reminders } = setup();
  expect(reminders.tools("home").map((tool) => tool.name)).toEqual([
    "reminders_create",
    "reminders_list",
    "reminders_update",
    "reminders_cancel",
  ]);
  expect(() =>
    reminders.create("home", alice, "thread", alice.id, {
      id: "wrong-zone",
      createdBy: alice.id,
      text: "Call grandma",
      at: "2090-11-01T09:00:00+02:00",
      timeZone: "Europe/Prague",
    })
  ).toThrow("UTC offset");
  expect(() =>
    reminders.create("home", alice, "thread", "eve", {
      id: "wrong-person",
      createdBy: alice.id,
      text: "Call grandma",
      ...time,
    })
  ).toThrow("Not found");
  expect(() => reminders.list("other", alice, null)).toThrow("Not found");
  expect(() =>
    reminders.get("home", { ...bob, id: "eve" }, null, "wrong-person")
  ).toThrow("Not found");
  database.close();
});

test("the agent tool creates a workspace reminder for the person who asked", async () => {
  const { database, reminders } = setup();
  const tool = reminders
    .tools("home")
    .find((candidate) => candidate.name === "reminders_create")!;
  const result = await tool.execute(
    { text: "Review the document", ...time },
    { conversationId: 1, taskId: 3 } as never,
    {} as never
  );
  expect(result.output?.[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("01/11/2090, 09:00 Europe/Prague"),
  });
  const [reminder] = reminders.list("home", alice, null);
  expect(reminder).toMatchObject({
    threadId: "thread",
    recipientId: alice.id,
    text: "Review the document",
  });
  const update = reminders
    .tools("home")
    .find((candidate) => candidate.name === "reminders_update")!;
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
    .find((candidate) => candidate.name === "reminders_cancel")!;
  await cancel.execute(
    { reminder: reminder!.id },
    { conversationId: 1, taskId: 5 } as never,
    {} as never
  );
  expect(reminders.get("home", alice, null, reminder!.id)).toMatchObject({
    text: "Review the new document",
    cancelledAt: expect.any(Number),
  });
  database.close();
});

test("an agent without a current person can name a workspace recipient", async () => {
  const { database, reminders } = setup(() => "Done", null);
  const tool = reminders
    .tools("home")
    .find((candidate) => candidate.name === "reminders_create")!;
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
  expect(reminders.list("home", alice, null)).toHaveLength(1);
  database.close();
});

test("a reminder runs as the person who asked for it or last changed it, not as its recipient", async () => {
  const { database, reminders, requesters, asking } = setup();
  const tool = (name: string) =>
    reminders.tools("home").find((candidate) => candidate.name === name)!;
  await tool("reminders_create").execute(
    { text: "Send the invoice", recipient: "Bob", ...time },
    { conversationId: 1, taskId: 6 } as never,
    {} as never
  );
  const [reminder] = reminders.list("home", alice, null);
  expect(reminder).toMatchObject({ recipientId: bob.id, createdBy: alice.id });
  await Promise.all(reminders.tick(reminder!.dueAt));
  expect(requesters).toEqual([alice.id]);

  const second = reminders.create("home", alice, "thread", alice.id, {
    id: "changed",
    createdBy: alice.id,
    text: "Pay rent",
    ...time,
  });
  asking.requester = bob;
  await tool("reminders_update").execute(
    { reminder: second.id, text: "Pay rent to me", ...time },
    { conversationId: 1, taskId: 7 } as never,
    {} as never
  );
  await Promise.all(reminders.tick(second.dueAt));
  expect(requesters).toEqual([alice.id, bob.id]);

  const older = reminders.create("home", alice, "thread", alice.id, {
    id: "older",
    createdBy: alice.id,
    text: "Water the plants",
    ...time,
  });
  database
    .query("UPDATE reminder SET created_by = NULL WHERE id = ?")
    .run(older.id);
  await Promise.all(reminders.tick(older.dueAt));
  expect(requesters).toEqual([alice.id, bob.id, null]);
  database.close();
});

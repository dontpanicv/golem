import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import type { Chats } from "../chats/chats.ts";
import { Places } from "../places/places.ts";
import type { User } from "../platform/auth.ts";
import { migrate } from "../platform/database.ts";
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
  const database = authDatabase();
  migrate(database);
  const chatsOf = (workspaceId: string) =>
    workspaceId === "home"
      ? [
          {
            id: "chat",
            workspaceId,
            topicId: "general",
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
    chatsIn: (workspaceId: string) => chatsOf(workspaceId),
    allChatsIn: (workspaceId: string) => chatsOf(workspaceId),
    chatOf: (workspaceId: string, conversationId: number) =>
      chatsOf(workspaceId).find(
        (chat) => chat.conversationId === conversationId
      ) ?? null,
  } as unknown as Pick<
    Workspaces,
    | "agentMember"
    | "allChatsIn"
    | "requireMember"
    | "members"
    | "chatOf"
    | "chatsIn"
  >;
  const calls: string[] = [];
  const requesters: (string | null)[] = [];
  const asking = { requester };
  const chats = {
    instruct: async (
      _chat: unknown,
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
  } as unknown as Pick<Chats, "instruct" | "realm" | "requester">;
  // OpenStreetMap's search, which has every place that it is asked for.
  const places = new Places(database, workspaces, (async (url: string) => {
    const osmId = new URL(url).searchParams.get("osm_ids");
    return Response.json([
      {
        osm_type: "node",
        osm_id: Number(osmId?.slice(1)),
        category: "shop",
        type: "furniture",
        name: `Shop ${osmId}`,
        display_name: `Shop ${osmId}, Brno`,
        lat: "49.15",
        lon: "16.62",
        boundingbox: ["49.15", "49.1501", "16.62", "16.6201"],
      },
    ]);
  }) as unknown as typeof fetch);
  return {
    database,
    workspaces,
    chats,
    places,
    reminders: new Reminders(database, workspaces, chats, places),
    calls,
    requesters,
    asking,
  };
}

test("one-time reminders run once, also when the machine starts after their due time", async () => {
  const { database, workspaces, chats, places, reminders, calls } = setup();
  const reminder = reminders.create("home", alice, "chat", alice.id, {
    id: "first",
    createdBy: alice.id,
    text: "Review the document",
    ...time,
  });
  expect(reminder.dueAt).toBe(Date.UTC(2090, 10, 1, 8));
  expect(reminders.tick(reminder.dueAt - 1)).toEqual([]);
  const restarted = new Reminders(database, workspaces, chats, places);
  await Promise.all(restarted.tick(reminder.dueAt + 60_000));
  expect(calls).toEqual(["reminder:first:0"]);
  expect(reminders.get("home", alice, null, "first").deliveredAt).toBeNumber();
  expect(reminders.tick(reminder.dueAt + 120_000)).toEqual([]);
  database.close();
});

test("a failed reminder retries, a quiet one is done, and a cancelled one stays quiet", async () => {
  let fail = true;
  const { database, reminders, calls } = setup((requestId) => {
    if (fail) {
      fail = false;
      throw new Error("The model failed");
    }
    return requestId.startsWith("reminder:quiet") ? null : "Done";
  });
  const quiet = reminders.create("home", alice, "chat", alice.id, {
    id: "quiet",
    createdBy: alice.id,
    text: "Water the plants",
    ...time,
    at: "2090-11-01T10:00:00+01:00",
  });
  const first = reminders.create("home", alice, "chat", alice.id, {
    id: "retry",
    createdBy: alice.id,
    text: "Call grandma",
    ...time,
  });
  const second = reminders.create("home", alice, "chat", alice.id, {
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
  await Promise.all(reminders.tick(quiet.dueAt));
  expect(reminders.get("home", alice, null, quiet.id).deliveredAt).toBeNumber();
  expect(calls).toEqual([
    "reminder:retry:0",
    "reminder:retry:1",
    "reminder:quiet:0",
  ]);
  database.close();
});

test("reminders stay in their workspace and reject a wrong time-zone offset", () => {
  const { database, reminders } = setup();
  expect(reminders.tools("home").map((tool) => tool.name)).toEqual([
    "reminders_create",
    "reminders_places",
    "reminders_search_points_of_interest",
    "reminders_create_at_point_of_interest",
    "reminders_list",
    "reminders_update",
    "reminders_cancel",
  ]);
  expect(() =>
    reminders.create("home", alice, "chat", alice.id, {
      id: "wrong-zone",
      createdBy: alice.id,
      text: "Call grandma",
      at: "2090-11-01T09:00:00+02:00",
      timeZone: "Europe/Prague",
    })
  ).toThrow("UTC offset");
  expect(() =>
    reminders.create("home", alice, "chat", "eve", {
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
    chatId: "chat",
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

  const second = reminders.create("home", alice, "chat", alice.id, {
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

  const older = reminders.create("home", alice, "chat", alice.id, {
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

test("a reminder at a place waits until its person arrives or leaves, once", async () => {
  const { database, places, reminders, calls } = setup();
  const cottage = places.create("home", alice, {
    name: "Cottage",
    latitude: 49.1,
    longitude: 16.2,
    radius: 300,
    shared: false,
  });
  const tool = reminders
    .tools("home")
    .find((candidate) => candidate.name === "reminders_create")!;
  await expect(
    tool.execute(
      { text: "Pack the tent", place: "Office", timeZone: "Europe/Prague" },
      { conversationId: 1, taskId: 7 } as never,
      {} as never
    )
  ).rejects.toThrow("Name one of these places: Cottage.");
  const listed = reminders
    .tools("home")
    .find((candidate) => candidate.name === "reminders_places")!;
  expect(
    (
      await listed.execute(
        {},
        { conversationId: 1, taskId: 8 } as never,
        {} as never
      )
    ).output
  ).toEqual([{ type: "text", text: "Cottage" }]);
  expect(
    (
      await listed.execute(
        { recipient: "Bob" },
        { conversationId: 1, taskId: 9 } as never,
        {} as never
      )
    ).output?.[0]
  ).toMatchObject({ text: expect.stringContaining("No places.") });
  // Alice's private place is not Bob's, so she cannot remind him there.
  await expect(
    tool.execute(
      {
        text: "Pack the tent",
        place: "cottage",
        recipient: "Bob",
        timeZone: "Europe/Prague",
      },
      { conversationId: 1, taskId: 8 } as never,
      {} as never
    )
  ).rejects.toThrow("There is no place for this reminder");
  const result = await tool.execute(
    { text: "Pack the tent", place: "cottage", timeZone: "Europe/Prague" },
    { conversationId: 1, taskId: 9 } as never,
    {} as never
  );
  expect(result.output?.[0]).toMatchObject({
    text: expect.stringContaining("When: the recipient arrives at Cottage"),
  });
  const [reminder] = reminders.list("home", alice, null);
  expect(reminder!.place).toEqual({
    id: cottage.id,
    name: "Cottage",
    latitude: 49.1,
    longitude: 16.2,
    radius: 300,
    event: "arrive",
  });
  expect(reminders.tick(Date.now() + 60_000)).toEqual([]);
  // Only the recipient's arrival, at this place, after the reminder was made, makes it due.
  const at = Date.now();
  expect(reminders.atPlace("home", bob.id, cottage.id, "arrive", at)).toEqual(
    []
  );
  expect(reminders.atPlace("home", alice.id, cottage.id, "leave", at)).toEqual(
    []
  );
  expect(
    reminders.atPlace("home", alice.id, cottage.id, "arrive", at - 60_000)
  ).toEqual([]);
  // A removed place keeps its reminder.
  places.remove("home", alice, cottage.id);
  await Promise.all(
    reminders.atPlace("home", alice.id, cottage.id, "arrive", at)
  );
  const [delivered] = reminders.list("home", alice, null);
  expect(delivered).toMatchObject({
    triggeredAt: at,
    dueAt: at,
    deliveredAt: expect.any(Number),
    place: { name: "Cottage" },
  });
  expect(
    reminders.atPlace("home", alice.id, cottage.id, "arrive", at + 1)
  ).toEqual([]);
  expect(calls).toEqual([`reminder:${reminder!.id}:0`]);
  database.close();
});

test("a reminder for an arrival where its person is now is due at once", () => {
  const { database, places, reminders } = setup();
  const home = places.create("home", alice, {
    name: "Home",
    latitude: 50.1,
    longitude: 14.4,
    radius: 200,
    shared: false,
  });
  places.record(home.id, alice.id, {
    event: "arrive",
    at: Date.now(),
    initial: true,
  });
  const create = (id: string, event: "arrive" | "leave") =>
    reminders.create("home", alice, "chat", alice.id, {
      id,
      text: "Water the plants",
      place: { id: home.id, event },
      timeZone: "Europe/Prague",
      createdBy: alice.id,
    });
  expect(create("arrive", "arrive").triggeredAt).toBeNumber();
  expect(create("leave", "leave").triggeredAt).toBeNull();
  database.close();
});

test("a reminder at a place fires within its window: not before its start, at once if its person is there then, and at its end anyway", async () => {
  const { database, places, reminders, calls } = setup();
  const office = places.create("home", alice, {
    name: "Office",
    latitude: 50.1,
    longitude: 14.4,
    radius: 200,
    shared: false,
  });
  const make = (
    id: string,
    place: { event: "arrive" | "leave"; from?: string; until?: string }
  ) =>
    reminders.create("home", alice, "chat", alice.id, {
      id,
      text: "The four work matters",
      place: { id: office.id, ...place },
      timeZone: "Europe/Prague",
      createdBy: alice.id,
    });
  const monday = Date.parse("2090-11-06T08:00:00+01:00");
  make("monday", { event: "arrive", from: "2090-11-06T08:00:00+01:00" });
  // An arrival before the window opens does not count.
  reminders.atPlace("home", alice.id, office.id, "arrive", monday - 60_000);
  places.record(office.id, alice.id, {
    event: "arrive",
    at: monday - 60_000,
    initial: true,
  });
  await Promise.all(reminders.tick(monday - 30_000));
  expect(calls).toEqual([]);
  // The person is already at the office when the window opens: it fires then.
  await Promise.all(reminders.tick(monday + 1000));
  expect(calls).toEqual(["reminder:monday:0"]);

  // A window that ends before the event comes: it fires at its end, once.
  make("shop", { event: "leave", until: "2090-11-07T18:00:00+01:00" });
  await Promise.all(reminders.tick(Date.parse("2090-11-07T17:59:00+01:00")));
  expect(calls).toEqual(["reminder:monday:0"]);
  await Promise.all(reminders.tick(Date.parse("2090-11-07T18:00:30+01:00")));
  await Promise.all(reminders.tick(Date.parse("2090-11-07T18:05:00+01:00")));
  expect(calls).toEqual(["reminder:monday:0", "reminder:shop:0"]);

  expect(() =>
    make("backwards", {
      event: "arrive",
      from: "2090-11-08T10:00:00+01:00",
      until: "2090-11-08T09:00:00+01:00",
    })
  ).toThrow("end after it starts");
  database.close();
});

test("a reminder at a point of interest is only for the person who asks, and fires when they arrive", async () => {
  const { database, places, reminders, calls, asking } = setup();
  const tool = reminders
    .tools("home")
    .find(
      (candidate) => candidate.name === "reminders_create_at_point_of_interest"
    )!;
  const parameters = {
    text: "Use the voucher",
    pointOfInterest: "N1",
    timeZone: "Europe/Prague",
  };
  const context = { conversationId: 1, taskId: 1 } as never;
  await tool.execute(parameters, context, {} as never);
  const [reminder] = reminders.list("home", alice, alice.id);
  expect(reminder).toMatchObject({
    recipientId: alice.id,
    place: { name: "Shop N1", event: "arrive", radius: 150 },
  });
  expect(places.list("home", alice)).toEqual([]);

  // Text only: the place stays.
  const update = reminders
    .tools("home")
    .find((candidate) => candidate.name === "reminders_update")!;
  await update.execute(
    {
      reminder: reminder!.id,
      text: "Use both vouchers",
      timeZone: "Europe/Prague",
    },
    context,
    {} as never
  );
  const changed = reminders.get("home", alice, null, reminder!.id);
  expect(changed).toMatchObject({
    text: "Use both vouchers",
    place: { id: reminder!.place!.id },
  });

  // Another member cannot use it, and neither can an agent alone.
  expect(() =>
    reminders.create("home", bob, "chat", alice.id, {
      id: "bob",
      createdBy: bob.id,
      text: "Spy",
      timeZone: "Europe/Prague",
      place: { id: reminder!.place!.id, event: "arrive" },
    })
  ).toThrow("Give a place that the recipient and the asker use");
  asking.requester = null;
  await expect(
    tool.execute(
      parameters,
      { conversationId: 1, taskId: 2 } as never,
      {} as never
    )
  ).rejects.toThrow("Only a person's own request");
  asking.requester = alice;

  const arrived = Date.now();
  await Promise.all(
    reminders.atPlace("home", alice.id, reminder!.place!.id, "arrive", arrived)
  );
  expect(calls).toEqual([`reminder:${reminder!.id}:0`]);
  database.close();
});

test("a person waits at 12 points of interest at most, and more reminders can wait at one of them", () => {
  const { database, reminders } = setup();
  const insert = database.query(
    "INSERT INTO place (id, workspace_id, owner_id, name, latitude, longitude, radius, shared, created_at, osm_id) VALUES (?, 'home', ?, ?, 49, 16, 150, 0, 0, ?)"
  );
  for (let index = 1; index <= 13; index += 1) {
    insert.run(`point-${index}`, alice.id, `Shop ${index}`, `N${index}`);
  }
  const create = (id: string, placeId: string) =>
    reminders.create("home", alice, "chat", alice.id, {
      id,
      createdBy: alice.id,
      text: "Buy it",
      timeZone: "Europe/Prague",
      place: { id: placeId, event: "arrive" },
    });
  for (let index = 1; index <= 12; index += 1) {
    create(`first-${index}`, `point-${index}`);
  }
  expect(() => create("over", "point-13")).toThrow("12 points of interest");
  create("second-at-one", "point-1");
  reminders.cancel("home", alice, alice.id, "first-2");
  expect(create("freed", "point-13").place?.name).toBe("Shop 13");
  database.close();
});

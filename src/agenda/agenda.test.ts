import { afterAll, beforeAll, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";

let golem: TestApp;
let alice: User;
let bob: User;

beforeAll(async () => {
  golem = await startTestApp();
  golem.faux.setResponses(
    Array.from({ length: 50 }, () => fauxAssistantMessage("Ok."))
  );
  alice = await person("Alice", "alice@example.com");
  bob = await person("Bob", "bob@example.com");
});
afterAll(() => golem.close());

async function person(name: string, email: string): Promise<User> {
  await golem.signIn(name, email);
  const { internalAdapter } = await golem.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(email))!;
  return { id: user.id, name: user.name, email: user.email };
}

/** A local time a day from now, in the server's time zone, with its offset. */
function tomorrow(): string {
  const at = new Date(Date.now() + 86_400_000);
  at.setSeconds(0, 0);
  const offset = -at.getTimezoneOffset();
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  const local = new Date(at.getTime() + offset * 60_000)
    .toISOString()
    .slice(0, 16);
  return `${local}:00${offset >= 0 ? "+" : "-"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

test("Golem keeps few suggestions per person, drops ones that cannot run, and never asks again what a person declined", async () => {
  const home = await golem.app.workspaces.create(alice, "Agenda");
  const [general] = golem.app.workspaces.topics(home.id, alice);
  const offer = (name: string, schedule = "0 7 * * *") =>
    golem.app.agenda.offer(home.id, "chat", general!.id, {
      kind: "routine",
      personId: alice.id,
      name,
      schedule,
      instructions: "Do it",
      topic: null,
    });
  offer("Broken", "not cron");
  golem.app.agenda.offer(home.id, "chat", general!.id, {
    kind: "reminder",
    personId: alice.id,
    text: "Too late",
    at: "2020-01-01T09:00:00+01:00",
  });
  offer("Weather");
  offer("weather");
  offer("Mail");
  offer("News");
  offer("Fourth");
  const names = () =>
    golem.app.agenda.suggestions(home.id, alice).map((item) => item.name);
  expect(names()).toEqual(["Weather", "Mail", "News"]);

  const [weather] = golem.app.agenda.suggestions(home.id, alice);
  const token = await golem.signIn("Alice", "alice@example.com");
  const declined = await golem.call(
    `/api/v1/workspaces/${home.id}/suggestions/${weather!.id}`,
    { token, body: { accept: false } }
  );
  expect(declined.status).toBe(204);
  offer("Weather");
  expect(names()).toEqual(["Mail", "News"]);
  expect(golem.app.routines.inWorkspace(home.id, alice.id)).toEqual([]);
  expect(golem.app.agenda.automations(home.id, alice.id)).toContain(
    'Suggested routine "Weather": declined'
  );
  // Another person cannot answer it.
  const bobToken = await golem.signIn("Bob", "bob@example.com");
  await golem.app.workspaces.addMember(home.id, alice, bob.email);
  const [mail] = golem.app.agenda.suggestions(home.id, alice);
  expect(
    (
      await golem.call(
        `/api/v1/workspaces/${home.id}/suggestions/${mail!.id}`,
        { token: bobToken, body: { accept: true } }
      )
    ).status
  ).toBe(404);
});

test("an accepted reminder waits in the person's orchestrator, shows in Upcoming, and the person cancels it there", async () => {
  const home = await golem.app.workspaces.create(alice, "Reminders");
  const [general] = golem.app.workspaces.topics(home.id, alice);
  golem.app.agenda.offer(home.id, "chat", general!.id, {
    kind: "reminder",
    personId: alice.id,
    text: "Call the dentist",
    at: tomorrow(),
  });
  const [suggestion] = golem.app.agenda.upcoming(home.id, alice).suggestions;
  expect(suggestion!.at).toBeGreaterThan(Date.now());
  await golem.app.agenda.answer(home.id, alice, suggestion!.id, true);

  const token = await golem.signIn("Alice", "alice@example.com");
  const upcoming = (await (
    await golem.call(`/api/v1/workspaces/${home.id}/upcoming`, { token })
  ).json()) as {
    reminders: { id: string; text: string; chatId: string }[];
    suggestions: unknown[];
    routines: unknown[];
    approvals: unknown[];
  };
  const orchestrator = await golem.app.chats.orchestrator(home.id, alice);
  expect(upcoming.suggestions).toEqual([]);
  expect(upcoming.approvals).toEqual([]);
  expect(upcoming.reminders.map((item) => [item.text, item.chatId])).toEqual([
    ["Call the dentist", orchestrator.id],
  ]);

  await golem.app.workspaces.addMember(home.id, alice, bob.email);
  const bobToken = await golem.signIn("Bob", "bob@example.com");
  const path = `/api/v1/workspaces/${home.id}/reminders/${upcoming.reminders[0]!.id}`;
  expect(
    (await golem.call(path, { token: bobToken, method: "DELETE" })).status
  ).toBe(404);
  expect((await golem.call(path, { token, method: "DELETE" })).status).toBe(
    204
  );
  expect(golem.app.agenda.upcoming(home.id, alice).reminders).toEqual([]);
});

test("the iPhone watches the places of its person's reminders and routines, and Golem decides what a report makes due", async () => {
  const home = await golem.app.workspaces.create(alice, "Places");
  const [general] = golem.app.workspaces.topics(home.id, alice);
  const cottage = golem.app.places.create(home.id, alice, {
    name: "Cottage",
    latitude: 49.1,
    longitude: 16.2,
    radius: 300,
    shared: false,
  });
  const orchestrator = await golem.app.chats.orchestrator(home.id, alice);
  const reminder = golem.app.reminders.create(
    home.id,
    alice,
    orchestrator.id,
    alice.id,
    {
      id: crypto.randomUUID(),
      text: "Pack the tent",
      place: { id: cottage.id, event: "arrive" },
      timeZone: "Europe/Prague",
      createdBy: alice.id,
    }
  );
  const routine = golem.app.routines.create(home.id, general!.id, {
    id: crypto.randomUUID(),
    name: "Heating",
    place: { id: cottage.id, event: "leave", personId: alice.id },
    instructions: "Turn off the heating.",
    createdBy: alice.id,
  });
  const token = await golem.signIn("Alice", "alice@example.com");
  const base = `/api/v1/workspaces/${home.id}/watched-places`;
  expect(await (await golem.call(base, { token })).json()).toEqual({
    places: [
      {
        id: cottage.id,
        name: "Cottage",
        latitude: 49.1,
        longitude: 16.2,
        radius: 300,
        reminders: [
          { id: reminder.id, text: "Pack the tent", event: "arrive" },
        ],
      },
    ],
  });
  const report = (body: unknown, place = cottage.id) =>
    golem.call(`${base}/${place}/reports`, { token, body });
  // Each report is after the reminder was made, and none is in the future.
  const now = Date.now();
  await Bun.sleep(50);
  expect((await report({ event: "arrive", at: now })).status).toBe(400);
  expect(
    (await report({ event: "arrive", at: now, initial: false }, "elsewhere"))
      .status
  ).toBe(404);
  const bobToken = await golem.signIn("Bob", "bob@example.com");
  expect(
    (
      await golem.call(`${base}/${cottage.id}/reports`, {
        token: bobToken,
        body: { event: "arrive", at: now, initial: false },
      })
    ).status
  ).toBe(404);
  // The iPhone starts to watch while Alice is away: no crossing, nothing is due.
  expect(
    (await report({ event: "leave", at: now, initial: true })).status
  ).toBe(204);
  expect(
    golem.app.reminders.get(home.id, alice, alice.id, reminder.id)
  ).toMatchObject({ triggeredAt: null });
  expect(golem.app.routines.get(routine.id, alice).lastRun).toBeNull();
  // She arrives: the reminder is due, and the iPhone stops watching for it.
  await report({ event: "arrive", at: now + 20, initial: false });
  expect(
    golem.app.reminders.get(home.id, alice, alice.id, reminder.id).triggeredAt
  ).toBe(now + 20);
  expect(golem.app.agenda.watchPlaces(home.id, alice)[0]!.reminders).toEqual(
    []
  );
  // A report that waited for a connection, older than the last one, changes nothing.
  await report({ event: "leave", at: now + 10, initial: false });
  expect(golem.app.routines.get(routine.id, alice).lastRun).toBeNull();
  // She leaves: the routine runs.
  await report({ event: "leave", at: now + 30, initial: false });
  await until(
    async () => golem.app.routines.get(routine.id, alice).lastRun,
    (run) => run !== null && run.outcome !== "running"
  );
});

test("a state at a place that the phone stopped watching does not make a new reminder there due", async () => {
  const home = await golem.app.workspaces.create(alice, "Stale");
  const flat = golem.app.places.create(home.id, alice, {
    name: "Flat",
    latitude: 50.1,
    longitude: 14.4,
    radius: 200,
    shared: false,
  });
  const orchestrator = await golem.app.chats.orchestrator(home.id, alice);
  const remind = () =>
    golem.app.reminders.create(home.id, alice, orchestrator.id, alice.id, {
      id: crypto.randomUUID(),
      text: "Send the invoice",
      place: { id: flat.id, event: "arrive" },
      timeZone: "Europe/Prague",
      createdBy: alice.id,
    });
  // Days ago the phone saw Alice arrive, then it stopped watching the place, and she left.
  golem.app.places.record(flat.id, alice.id, {
    event: "arrive",
    at: Date.now() - 86_400_000,
    initial: false,
  });
  const token = await golem.signIn("Alice", "alice@example.com");
  const base = `/api/v1/workspaces/${home.id}/watched-places`;
  expect(await (await golem.call(base, { token })).json()).toEqual({
    places: [],
  });
  const reminder = remind();
  expect(reminder.triggeredAt).toBeNull();
  // The phone watches the place again, and says that she is there.
  await golem.call(base, { token });
  const at = Date.now();
  expect(
    (
      await golem.call(`${base}/${flat.id}/reports`, {
        token,
        body: { event: "arrive", at, initial: true },
      })
    ).status
  ).toBe(204);
  expect(
    golem.app.reminders.get(home.id, alice, alice.id, reminder.id).triggeredAt
  ).toBe(at);
  // While the phone watches the place, its state there counts.
  expect(remind().triggeredAt).toBeNumber();
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, type TestApp } from "../../test/harness.ts";
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
  const [general] = golem.app.workspaces.channels(home.id, alice);
  const offer = (name: string, schedule = "0 7 * * *") =>
    golem.app.agenda.offer(home.id, "thread", general!.id, {
      kind: "routine",
      personId: alice.id,
      name,
      schedule,
      instructions: "Do it",
      channel: null,
    });
  offer("Broken", "not cron");
  golem.app.agenda.offer(home.id, "thread", general!.id, {
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
  const [general] = golem.app.workspaces.channels(home.id, alice);
  golem.app.agenda.offer(home.id, "thread", general!.id, {
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
    reminders: { id: string; text: string; threadId: string }[];
    suggestions: unknown[];
    routines: unknown[];
    approvals: unknown[];
  };
  const orchestrator = await golem.app.threads.orchestrator(home.id, alice);
  expect(upcoming.suggestions).toEqual([]);
  expect(upcoming.approvals).toEqual([]);
  expect(upcoming.reminders.map((item) => [item.text, item.threadId])).toEqual([
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

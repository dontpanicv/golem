import { expect, test } from "bun:test";
import type { Routine, Upcoming } from "../app/types.ts";
import { agendaGroups, itemId, scheduleWords } from "./data.ts";

const NOW = new Date(2026, 9, 31, 10, 0).getTime();
const HOUR = 60 * 60 * 1000;

function routine(id: string, fields: Partial<Routine>): Routine {
  return {
    id,
    topicId: "topic",
    name: id,
    schedule: "0 7 * * *",
    place: null,
    enabled: true,
    nextRunAt: null,
    chatId: null,
    lastRun: null,
    ...fields,
  };
}

test("the agenda shows what needs the person, the suggestions, then what runs by day, soonest first, the reminders at a place, the routines at a place, and the paused routines", () => {
  const upcoming: Upcoming = {
    routines: [
      routine("later", { nextRunAt: NOW + 10 * 24 * HOUR }),
      routine("today", { nextRunAt: NOW + 2 * HOUR }),
      routine("paused", { enabled: false }),
      routine("home", {
        schedule: null,
        place: {
          id: "place",
          name: "Home",
          latitude: 50.1,
          longitude: 14.4,
          radius: 200,
          event: "arrive",
          personId: "alice",
        },
      }),
      routine("broken", {
        nextRunAt: NOW + HOUR,
        lastRun: {
          id: "run",
          routineId: "broken",
          routineName: "broken",
          startedAt: NOW - HOUR,
          finishedAt: NOW - HOUR,
          outcome: "failed",
          error: "No credential",
        },
      }),
    ],
    reminders: [
      {
        id: "week",
        chatId: "chat",
        recipientId: "alice",
        createdBy: "alice",
        text: "Call the dentist",
        dueAt: NOW + 3 * 24 * HOUR,
        place: null,
        triggeredAt: null,
        notBefore: null,
        notAfter: null,
      },
      {
        id: "tomorrow",
        chatId: "chat",
        recipientId: "alice",
        createdBy: "alice",
        text: "Take out the bins",
        dueAt: NOW + 20 * HOUR,
        place: null,
        triggeredAt: null,
        notBefore: null,
        notAfter: null,
      },
      {
        id: "soon",
        chatId: "chat",
        recipientId: "alice",
        createdBy: "alice",
        text: "Water the plants",
        dueAt: NOW + HOUR,
        place: null,
        triggeredAt: null,
        notBefore: null,
        notAfter: null,
      },
      {
        id: "cottage",
        chatId: "chat",
        recipientId: "alice",
        createdBy: "alice",
        text: "Pack the tent",
        dueAt: NOW - HOUR,
        place: {
          id: "place",
          name: "Cottage",
          latitude: 49.1,
          longitude: 16.2,
          radius: 300,
          event: "arrive",
        },
        triggeredAt: null,
        notBefore: null,
        notAfter: null,
      },
    ],
    suggestions: [
      {
        id: "plants",
        kind: "routine",
        name: "Plants",
        text: "Remind me to water the plants",
        schedule: "0 8 * * 6",
        at: NOW + 24 * HOUR,
        topicId: "topic",
        chatId: "chat",
        createdAt: NOW,
      },
    ],
    approvals: [
      {
        chatId: "chat",
        approval: {
          id: "deploy",
          tool: "hands_run",
          text: "Run on bender: make deploy",
          approverId: null,
          allowsTurn: true,
          expiresAt: NOW + HOUR,
        },
      },
    ],
  };
  const groups = agendaGroups(upcoming, NOW).map((group) => [
    group.title,
    group.items.map(itemId),
  ]);
  expect(groups).toEqual([
    ["Needs you", ["deploy", "broken"]],
    ["Suggested", ["plants"]],
    ["Today", ["soon", "today"]],
    ["Tomorrow", ["tomorrow"]],
    ["This week", ["week"]],
    ["Later", ["later"]],
    ["At a place", ["cottage"]],
    ["Routines at a place", ["home"]],
    ["Paused", ["paused"]],
  ]);
});

test("a schedule shows in plain words, or as itself when it is unusual", () => {
  expect(scheduleWords("0 7 * * *")).toBe("Every day at 07:00");
  expect(scheduleWords("30 7 * * 1-5")).toBe("Weekdays at 07:30");
  expect(scheduleWords("0 9 * * 0,6")).toBe("Weekends at 09:00");
  expect(scheduleWords("0 18 * * 1,3")).toBe(
    "Every Monday, Wednesday at 18:00"
  );
  expect(scheduleWords("0 8 1 * *")).toBe("Every month on day 1 at 08:00");
  expect(scheduleWords("*/15 * * * *")).toBe("Every 15 minutes");
  expect(scheduleWords("5 * * * *")).toBe("Every hour at :05");
  expect(scheduleWords("0 7 * 1 *")).toBe("0 7 * 1 *");
  expect(scheduleWords("0 7-9 * * *")).toBe("0 7-9 * * *");
});

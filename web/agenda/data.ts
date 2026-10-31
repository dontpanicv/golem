import { queryOptions, useMutation } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type {
  Approval,
  Reminder,
  Routine,
  Suggestion,
  Upcoming,
} from "../app/types.ts";

/** What Golem runs for the person and what waits for them. */
export function upcomingQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspaces", workspaceId, "upcoming"],
    queryFn: ({ signal }) =>
      request<Upcoming>(`/workspaces/${workspaceId}/upcoming`, { signal }),
  });
}

/** Loads the agenda again, and the routines of the channels, which an accepted suggestion or a pause changes. */
function refresh(workspaceId: string) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: upcomingQuery(workspaceId).queryKey,
    }),
    queryClient.invalidateQueries({
      queryKey: ["workspaces", workspaceId, "routines"],
    }),
  ]);
}

/** Accepts or declines a suggestion: accepting makes the routine or the reminder as the person's own. */
export function useAnswerSuggestion(workspaceId: string) {
  return useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) =>
      request(`/workspaces/${workspaceId}/suggestions/${id}`, {
        method: "POST",
        body: { accept },
      }),
    onSettled: () => refresh(workspaceId),
  });
}

export function useCancelReminder(workspaceId: string) {
  return useMutation({
    mutationFn: (id: string) =>
      request(`/workspaces/${workspaceId}/reminders/${id}`, {
        method: "DELETE",
      }),
    onSettled: () => refresh(workspaceId),
  });
}

/** Pauses or resumes a routine. */
export function useRoutineEnabled(workspaceId: string) {
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      request(`/routines/${id}`, { method: "PUT", body: { enabled } }),
    onSettled: () => refresh(workspaceId),
  });
}

export type AgendaItem =
  | {
      readonly kind: "approval";
      readonly threadId: string;
      readonly approval: Approval;
    }
  | { readonly kind: "failed"; readonly routine: Routine }
  | { readonly kind: "suggestion"; readonly suggestion: Suggestion }
  | { readonly kind: "routine"; readonly routine: Routine }
  | { readonly kind: "reminder"; readonly reminder: Reminder };

export interface AgendaGroup {
  readonly title: string;
  readonly items: readonly AgendaItem[];
}

const DAY = 24 * 60 * 60 * 1000;

/** The id of what an item shows, unique within its kind. */
export function itemId(item: AgendaItem): string {
  switch (item.kind) {
    case "approval":
      return item.approval.id;
    case "suggestion":
      return item.suggestion.id;
    case "reminder":
      return item.reminder.id;
    default:
      return item.routine.id;
  }
}

/**
 * The agenda in groups, each only when it has items: what needs the person, the suggestions, then what runs today,
 * tomorrow, in the next 7 days, and later, soonest first, and the paused routines. A failed routine shows only in
 * Needs you.
 */
export function agendaGroups(upcoming: Upcoming, now: number): AgendaGroup[] {
  const failed = upcoming.routines.filter(
    (routine) => routine.lastRun?.outcome === "failed"
  );
  const others = upcoming.routines.filter(
    (routine) => !failed.includes(routine)
  );
  const timed = [
    ...others.flatMap((routine) =>
      routine.enabled && routine.nextRunAt !== null
        ? [
            {
              at: routine.nextRunAt,
              item: { kind: "routine", routine } as const,
            },
          ]
        : []
    ),
    ...upcoming.reminders.map((reminder) => ({
      at: reminder.dueAt,
      item: { kind: "reminder", reminder } as const,
    })),
  ].sort((first, second) => first.at - second.at);
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  // Local midnights: half a day more, then back to midnight, as a day with a summer time change has 23 or 25 hours.
  const tomorrow = new Date(midnight + DAY * 1.5).setHours(0, 0, 0, 0);
  const afterTomorrow = new Date(midnight + DAY * 2.5).setHours(0, 0, 0, 0);
  const nextWeek = new Date(midnight + DAY * 7.5).setHours(0, 0, 0, 0);
  const between = (from: number, to: number) =>
    timed.filter(({ at }) => at >= from && at < to).map(({ item }) => item);
  return [
    {
      title: "Needs you",
      items: [
        ...upcoming.approvals.map(
          ({ threadId, approval }) =>
            ({ kind: "approval", threadId, approval }) as const
        ),
        ...failed.map((routine) => ({ kind: "failed", routine }) as const),
      ],
    },
    {
      title: "Suggested",
      items: upcoming.suggestions.map(
        (suggestion) => ({ kind: "suggestion", suggestion }) as const
      ),
    },
    {
      title: "Today",
      items: between(Number.NEGATIVE_INFINITY, tomorrow),
    },
    { title: "Tomorrow", items: between(tomorrow, afterTomorrow) },
    { title: "This week", items: between(afterTomorrow, nextWeek) },
    {
      title: "Later",
      items: between(nextWeek, Number.POSITIVE_INFINITY),
    },
    {
      title: "Paused",
      items: others
        .filter((routine) => !routine.enabled)
        .map((routine) => ({ kind: "routine", routine }) as const),
    },
  ].filter((group) => group.items.length > 0);
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * A cron expression in plain words, such as "Every day at 07:00" or "Weekdays at 07:30". A schedule that this does
 * not know shows as the expression itself.
 */
export function scheduleWords(schedule: string): string {
  const [minute, hour, dayOfMonth, month, weekday] = schedule
    .trim()
    .split(/\s+/);
  const every = minute?.match(/^\*\/(\d+)$/);
  if (every && [hour, dayOfMonth, month, weekday].every((f) => f === "*")) {
    return `Every ${every[1]} minutes`;
  }
  if (!(minute && /^\d+$/.test(minute) && month === "*")) {
    return schedule;
  }
  if (hour === "*" && dayOfMonth === "*" && weekday === "*") {
    return `Every hour at :${minute.padStart(2, "0")}`;
  }
  if (!(hour && /^\d+$/.test(hour))) {
    return schedule;
  }
  const time = `at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dayOfMonth !== "*") {
    return /^\d+$/.test(dayOfMonth ?? "") && weekday === "*"
      ? `Every month on day ${dayOfMonth} ${time}`
      : schedule;
  }
  const days = weekdayList(weekday ?? "");
  if (days === null) {
    return schedule;
  }
  if (days.length === 7) {
    return `Every day ${time}`;
  }
  if (days.join() === "1,2,3,4,5") {
    return `Weekdays ${time}`;
  }
  if (days.join() === "0,6") {
    return `Weekends ${time}`;
  }
  return `Every ${days.map((index) => WEEKDAYS[index]).join(", ")} ${time}`;
}

/** The weekdays of a cron field, Sunday as 0, such as "1-5" or "1,3"; null for a field this does not read. */
function weekdayList(field: string): number[] | null {
  if (field === "*") {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = part.match(/^(\d)(?:-(\d))?$/);
    if (!range) {
      return null;
    }
    const from = Number(range[1]);
    const to = Number(range[2] ?? range[1]);
    if (from > to || to > 7) {
      return null;
    }
    for (let index = from; index <= to; index += 1) {
      days.add(index % 7);
    }
  }
  return [...days].sort((first, second) => first - second);
}

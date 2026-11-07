import type { Database } from "bun:sqlite";
import type { Place, PlaceEvent, Places } from "../places/places.ts";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
import type { Threads } from "../threads/threads.ts";
import type { Realm, Workspaces } from "../workspaces/workspaces.ts";
import { reminderTools } from "./tools.ts";

export interface Reminder {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly recipientId: string;
  /** The person who asked for the reminder or last changed it; its turn runs as them. */
  readonly createdBy: string | null;
  readonly text: string;
  /** When it is due; for a reminder at a place, when it was made, until the iPhone reports the event. */
  readonly dueAt: number;
  readonly timeZone: string;
  /** The place and the event that a reminder at a place waits for; null for a reminder at a time. */
  readonly place: ReminderPlace | null;
  /** When the person arrived at or left the place of a reminder at a place, as their iPhone reported. */
  readonly triggeredAt: number | null;
  /** For a reminder at a place: it fires only from this time; null for at once. */
  readonly notBefore: number | null;
  /** For a reminder at a place: if the event has not come by this time, it fires then anyway; null for never. */
  readonly notAfter: number | null;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  readonly deliveredAt: number | null;
  readonly cancelledAt: number | null;
}

export interface ReminderPlace
  extends Pick<Place, "id" | "name" | "latitude" | "longitude" | "radius"> {
  readonly event: PlaceEvent;
}

export interface ReminderInput {
  readonly text: string;
  /** A local ISO date and time with its UTC offset, such as 2026-11-01T09:00:00+01:00; or give `place`. */
  readonly at?: string;
  /**
   * The place, which the recipient and the asker use, and the event that the reminder waits for, within an optional
   * window: not before `from`, and at `until` at the latest, both local ISO times with their UTC offset.
   */
  readonly place?: {
    readonly id: string;
    readonly event: PlaceEvent;
    readonly from?: string;
    readonly until?: string;
  };
  readonly timeZone: string;
  /** The person who asks, or null for the agent alone. */
  readonly createdBy: string | null;
}

type ReminderWorkspaces = Pick<
  Workspaces,
  | "agentMember"
  | "allThreadsIn"
  | "requireMember"
  | "members"
  | "threadOf"
  | "threadsIn"
>;
type ReminderThreads = Pick<Threads, "instruct" | "realm" | "requester">;
type ReminderPlaces = Pick<Places, "find" | "inside" | "usable">;

interface ReminderRow extends Omit<Reminder, "place"> {
  readonly placeId: string | null;
  readonly placeEvent: PlaceEvent | null;
}

const TICK = 30_000;

/**
 * One-time reminders of a workspace, at a time or at a place. The agent writes the reminder, and the due runner wakes
 * its thread; a reminder at a place is due when its person's iPhone reports that they arrived or left.
 */
export class Reminders {
  private readonly running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly database: Database,
    private readonly workspaces: ReminderWorkspaces,
    private readonly threads: ReminderThreads,
    private readonly places: ReminderPlaces
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => {
      this.tick();
    }, TICK);
  }

  close(): void {
    clearInterval(this.timer);
  }

  tools(workspaceId: string) {
    return reminderTools(
      this,
      this.workspaces,
      this.threads,
      this.places,
      workspaceId
    );
  }

  create(
    workspaceId: string,
    actor: User,
    threadId: string,
    recipientId: string,
    input: ReminderInput & { readonly id: string }
  ): Reminder {
    this.workspaces.requireMember(workspaceId, actor);
    const thread = this.workspaces
      .allThreadsIn(workspaceId)
      .find((candidate) => candidate.id === threadId);
    // The reminder is in its thread, so its recipient must see the thread.
    if (!thread || (thread.realm !== null && thread.realm !== recipientId)) {
      throw notFound();
    }
    this.requireRecipient(workspaceId, actor, recipientId);
    const now = Date.now();
    const when = this.when(workspaceId, recipientId, input, now);
    this.database
      .query(
        "INSERT OR IGNORE INTO reminder (id, workspace_id, thread_id, recipient_id, created_by, text, due_at, time_zone, next_attempt_at, place_id, place_event, triggered_at, not_before, not_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.id,
        workspaceId,
        threadId,
        recipientId,
        input.createdBy,
        required(input.text, "Reminder"),
        when.dueAt,
        input.timeZone,
        when.dueAt,
        when.placeId,
        when.placeEvent,
        when.triggeredAt,
        when.notBefore,
        when.notAfter,
        now,
        now
      );
    return this.get(workspaceId, actor, thread.realm, input.id);
  }

  /** The reminders in the threads that `realm` sees. */
  list(workspaceId: string, actor: User, realm: Realm): Reminder[] {
    this.workspaces.requireMember(workspaceId, actor);
    const threads = new Set(
      this.workspaces.threadsIn(workspaceId, realm).map((thread) => thread.id)
    );
    return (
      this.database
        .query(
          `SELECT ${COLUMNS} FROM reminder WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY due_at`
        )
        .all(workspaceId) as ReminderRow[]
    )
      .filter((reminder) => threads.has(reminder.threadId))
      .map((row) => this.reminderOf(row));
  }

  get(workspaceId: string, actor: User, realm: Realm, id: string): Reminder {
    this.workspaces.requireMember(workspaceId, actor);
    const reminder = this.database
      .query(
        `SELECT ${COLUMNS} FROM reminder WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(id, workspaceId) as ReminderRow | null;
    if (!reminder) {
      throw notFound();
    }
    if (
      !this.workspaces
        .threadsIn(workspaceId, realm)
        .some((thread) => thread.id === reminder.threadId)
    ) {
      throw notFound();
    }
    return this.reminderOf(reminder);
  }

  update(
    workspaceId: string,
    actor: User,
    realm: Realm,
    id: string,
    input: ReminderInput
  ): Reminder {
    const reminder = this.get(workspaceId, actor, realm, id);
    if (this.running.has(id)) {
      throw new Error("This reminder is running now.");
    }
    if (reminder.deliveredAt !== null || reminder.cancelledAt !== null) {
      throw new Error("This reminder is no longer pending.");
    }
    if (reminder.triggeredAt !== null) {
      throw new Error("This reminder is due now.");
    }
    const now = Date.now();
    const when = this.when(workspaceId, reminder.recipientId, input, now);
    this.database
      .query(
        "UPDATE reminder SET text = ?, created_by = ?, due_at = ?, time_zone = ?, next_attempt_at = ?, place_id = ?, place_event = ?, triggered_at = ?, not_before = ?, not_after = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?"
      )
      .run(
        required(input.text, "Reminder"),
        input.createdBy,
        when.dueAt,
        input.timeZone,
        when.dueAt,
        when.placeId,
        when.placeEvent,
        when.triggeredAt,
        when.notBefore,
        when.notAfter,
        now,
        id,
        workspaceId
      );
    return this.get(workspaceId, actor, realm, id);
  }

  cancel(workspaceId: string, actor: User, realm: Realm, id: string): Reminder {
    const reminder = this.get(workspaceId, actor, realm, id);
    if (this.running.has(id)) {
      throw new Error("This reminder is running now.");
    }
    if (reminder.deliveredAt !== null) {
      throw new Error("This reminder was already delivered.");
    }
    this.database
      .query(
        "UPDATE reminder SET cancelled_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND cancelled_at IS NULL"
      )
      .run(Date.now(), Date.now(), id, workspaceId);
    return this.get(workspaceId, actor, realm, id);
  }

  /**
   * Makes the person's pending reminders at a place that wait for this event due, when their iPhone reports that they
   * arrived or left at `at`; a reminder made after that time, or whose window has not opened, waits for the next one.
   */
  atPlace(
    workspaceId: string,
    personId: string,
    placeId: string,
    event: PlaceEvent,
    at: number
  ): Promise<void>[] {
    const { changes } = this.database
      .query(
        "UPDATE reminder SET triggered_at = $at, due_at = $at, next_attempt_at = $at, updated_at = $now WHERE workspace_id = $workspaceId AND recipient_id = $personId AND place_id = $placeId AND place_event = $event AND created_at <= $at AND (not_before IS NULL OR not_before <= $at) AND (not_after IS NULL OR $at <= not_after) AND triggered_at IS NULL AND delivered_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL"
      )
      .run({ at, now: Date.now(), workspaceId, personId, placeId, event });
    return changes > 0 ? this.tick() : [];
  }

  /** Runs due reminders, also after the machine was off at their due time. */
  tick(now = Date.now()): Promise<void>[] {
    this.openWindows(now);
    const due = (
      this.database
        .query(
          `SELECT ${COLUMNS} FROM reminder WHERE due_at <= ? AND next_attempt_at <= ? AND (place_id IS NULL OR triggered_at IS NOT NULL) AND delivered_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL ORDER BY due_at`
        )
        .all(now, now) as ReminderRow[]
    ).map((row) => this.reminderOf(row));
    return due
      .filter((reminder) => {
        if (this.running.has(reminder.id)) {
          return false;
        }
        try {
          this.workspaces.requireMember(reminder.workspaceId, {
            id: reminder.recipientId,
            name: "",
            email: "",
          });
        } catch {
          return false;
        }
        return this.workspaces
          .allThreadsIn(reminder.workspaceId)
          .some((thread) => thread.id === reminder.threadId);
      })
      .map((reminder) => this.run(reminder, now));
  }

  /**
   * Makes due a reminder for an arrival whose window opened while its person is already at the place, and one whose
   * window ended before its event came: it fires then anyway, so a reminder is never lost.
   */
  private openWindows(now: number): void {
    const opened = this.database
      .query(
        "SELECT id, recipient_id AS recipientId, place_id AS placeId FROM reminder WHERE place_event = 'arrive' AND not_before IS NOT NULL AND not_before <= ? AND triggered_at IS NULL AND delivered_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL"
      )
      .all(now) as { id: string; recipientId: string; placeId: string }[];
    for (const reminder of opened) {
      if (this.places.inside(reminder.placeId, reminder.recipientId) === true) {
        this.database
          .query(
            "UPDATE reminder SET triggered_at = ?, due_at = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND triggered_at IS NULL"
          )
          .run(now, now, now, now, reminder.id);
      }
    }
    this.database
      .query(
        "UPDATE reminder SET triggered_at = not_after, due_at = not_after, next_attempt_at = not_after, updated_at = ? WHERE place_id IS NOT NULL AND not_after IS NOT NULL AND not_after <= ? AND triggered_at IS NULL AND delivered_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL"
      )
      .run(now, now);
  }

  private async run(reminder: Reminder, now: number): Promise<void> {
    this.running.add(reminder.id);
    try {
      const thread = this.workspaces
        .allThreadsIn(reminder.workspaceId)
        .find((candidate) => candidate.id === reminder.threadId)!;
      const member = this.workspaces
        .members(reminder.workspaceId, {
          id: reminder.recipientId,
          name: "",
          email: "",
        })
        .find((candidate) => candidate.userId === reminder.recipientId);
      if (!member) {
        throw new Error("The reminder recipient is no longer a member.");
      }
      // A QUIET answer is a reminder done: nothing needs the person now, and a retry would ask the agent again.
      await this.threads.instruct(
        thread,
        `${occasion(reminder, member.name)} It is now ${new Date(now).toISOString()}. Remind ${member.name} (member ${member.userId}): ${reminder.text}. When it names matters that Golem follows, read intake_read first and leave out what is already handled. Answer in this thread.`,
        `reminder:${reminder.id}:${reminder.attempts}`,
        [reminder.recipientId],
        // The turn is the asker's, with their own integrations: the text is theirs, not the recipient's.
        reminder.createdBy,
        "reminder"
      );
      this.database
        .query(
          "UPDATE reminder SET delivered_at = ?, updated_at = ?, last_error = NULL WHERE id = ? AND delivered_at IS NULL AND cancelled_at IS NULL"
        )
        .run(Date.now(), Date.now(), reminder.id);
    } catch (error) {
      const attempts = reminder.attempts + 1;
      this.database
        .query(
          "UPDATE reminder SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND delivered_at IS NULL AND cancelled_at IS NULL"
        )
        .run(
          attempts,
          now + Math.min(60_000 * 2 ** Math.min(attempts, 6), 60 * 60_000),
          (error as Error).message,
          Date.now(),
          reminder.id
        );
    } finally {
      this.running.delete(reminder.id);
    }
  }

  /** The due time of a reminder at a time, or the place of a reminder at a place, which its people must use. */
  private when(
    workspaceId: string,
    recipientId: string,
    input: ReminderInput,
    now: number
  ): {
    dueAt: number;
    placeId: string | null;
    placeEvent: PlaceEvent | null;
    triggeredAt: number | null;
    notBefore: number | null;
    notAfter: number | null;
  } {
    if ((input.at === undefined) === (input.place === undefined)) {
      throw new HttpError(400, "Give a reminder a time or a place.");
    }
    if (input.at !== undefined) {
      return {
        dueAt: dueTime(input.at, input.timeZone, now),
        placeId: null,
        placeEvent: null,
        triggeredAt: null,
        notBefore: null,
        notAfter: null,
      };
    }
    const { id, event, from, until } = input.place!;
    const notBefore = from ? dueTime(from, input.timeZone, now) : null;
    const notAfter = until ? dueTime(until, input.timeZone, now) : null;
    if (notBefore !== null && notAfter !== null && notAfter <= notBefore) {
      throw new HttpError(400, "A reminder's time must end after it starts.");
    }
    const people = [recipientId, input.createdBy ?? recipientId];
    if (
      !(
        (event === "arrive" || event === "leave") &&
        people.every((personId) =>
          this.places
            .usable(workspaceId, personId)
            .some((place) => place.id === id)
        )
      )
    ) {
      throw new HttpError(
        400,
        "Give a place that the recipient and the asker use, and arrive or leave."
      );
    }
    // A new reminder starts as outside: one for an arrival where the person is now is due at once, or when its time starts.
    const inside =
      event === "arrive" &&
      notBefore === null &&
      this.places.inside(id, recipientId) === true;
    return {
      dueAt: now,
      placeId: id,
      placeEvent: event,
      triggeredAt: inside ? now : null,
      notBefore,
      notAfter,
    };
  }

  private reminderOf({ placeId, placeEvent, ...row }: ReminderRow): Reminder {
    const place = placeId ? this.places.find(row.workspaceId, placeId) : null;
    return {
      ...row,
      place: place
        ? {
            id: place.id,
            name: place.name,
            latitude: place.latitude,
            longitude: place.longitude,
            radius: place.radius,
            event: placeEvent!,
          }
        : null,
    };
  }

  private requireRecipient(
    workspaceId: string,
    actor: User,
    recipientId: string
  ): void {
    if (
      !this.workspaces
        .members(workspaceId, actor)
        .some((member) => member.userId === recipientId)
    ) {
      throw notFound();
    }
  }
}

/** Why a reminder runs now: its time came, its person arrived or left, or its window ended before that. */
function occasion(reminder: Reminder, name: string): string {
  const at = `${new Date(reminder.dueAt).toISOString()} (${reminder.timeZone})`;
  const { place } = reminder;
  if (!place) {
    return `One-time reminder ${reminder.id} was due at ${at}.`;
  }
  const event = `${place.event === "arrive" ? "arrived at" : "left"} ${place.name}`;
  if (
    reminder.notAfter !== null &&
    reminder.triggeredAt === reminder.notAfter
  ) {
    return `Place reminder ${reminder.id}: its time ended at ${at} before ${name} ${event}; say so as you remind.`;
  }
  return `Place reminder ${reminder.id}: ${name} ${event} at ${at}.`;
}

const COLUMNS =
  "id, workspace_id AS workspaceId, thread_id AS threadId, recipient_id AS recipientId, created_by AS createdBy, text, due_at AS dueAt, time_zone AS timeZone, place_id AS placeId, place_event AS placeEvent, triggered_at AS triggeredAt, not_before AS notBefore, not_after AS notAfter, attempts, next_attempt_at AS nextAttemptAt, last_error AS lastError, delivered_at AS deliveredAt, cancelled_at AS cancelledAt";

/** The UTC time of `at`, a local time with its offset in `timeZone`; throws when it is wrong or not in the future. */
export function dueTime(at: string, timeZone: string, now: number): number {
  const match =
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::\d\d)?([+-]\d\d:\d\d)$/.exec(at);
  if (!match) {
    throw new Error(
      "Use a date and time with a UTC offset, such as 2026-11-01T09:00:00+01:00."
    );
  }
  const dueAt = Date.parse(at);
  if (!Number.isFinite(dueAt) || dueAt <= now) {
    throw new Error("The reminder time must be in the future.");
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(dueAt);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value;
  if (
    [
      part("year"),
      part("month"),
      part("day"),
      part("hour"),
      part("minute"),
    ].join("-") !== match.slice(1, 6).join("-")
  ) {
    throw new Error(
      "The UTC offset does not match the time zone at that date."
    );
  }
  return dueAt;
}

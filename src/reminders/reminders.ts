import type { Database } from "bun:sqlite";
import type { User } from "../platform/auth.ts";
import { notFound, required } from "../platform/errors.ts";
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
  readonly dueAt: number;
  readonly timeZone: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  readonly deliveredAt: number | null;
  readonly cancelledAt: number | null;
}

export interface ReminderInput {
  readonly text: string;
  /** A local ISO date and time with its UTC offset, such as 2026-11-01T09:00:00+01:00. */
  readonly at: string;
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
type ReminderThreads = Pick<Threads, "instruct" | "requester">;

const TICK = 30_000;

/** One-time reminders of a workspace. The agent writes the reminder, and the due runner wakes its thread. */
export class Reminders {
  private readonly running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly database: Database,
    private readonly workspaces: ReminderWorkspaces,
    private readonly threads: ReminderThreads
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
    return reminderTools(this, this.workspaces, this.threads, workspaceId);
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
    const dueAt = dueTime(input.at, input.timeZone, now);
    this.database
      .query(
        "INSERT OR IGNORE INTO reminder (id, workspace_id, thread_id, recipient_id, created_by, text, due_at, time_zone, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.id,
        workspaceId,
        threadId,
        recipientId,
        input.createdBy,
        required(input.text, "Reminder"),
        dueAt,
        input.timeZone,
        dueAt,
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
        .all(workspaceId) as Reminder[]
    ).filter((reminder) => threads.has(reminder.threadId));
  }

  get(workspaceId: string, actor: User, realm: Realm, id: string): Reminder {
    this.workspaces.requireMember(workspaceId, actor);
    const reminder = this.database
      .query(
        `SELECT ${COLUMNS} FROM reminder WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(id, workspaceId) as Reminder | null;
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
    return reminder;
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
    const now = Date.now();
    const dueAt = dueTime(input.at, input.timeZone, now);
    this.database
      .query(
        "UPDATE reminder SET text = ?, created_by = ?, due_at = ?, time_zone = ?, next_attempt_at = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?"
      )
      .run(
        required(input.text, "Reminder"),
        input.createdBy,
        dueAt,
        input.timeZone,
        dueAt,
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

  /** Runs due reminders, also after the machine was off at their due time. */
  tick(now = Date.now()): Promise<void>[] {
    const due = this.database
      .query(
        `SELECT ${COLUMNS} FROM reminder WHERE due_at <= ? AND next_attempt_at <= ? AND delivered_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL ORDER BY due_at`
      )
      .all(now, now) as Reminder[];
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
      const answer = await this.threads.instruct(
        thread,
        `One-time reminder ${reminder.id} was due at ${new Date(reminder.dueAt).toISOString()} (${reminder.timeZone}). It is now ${new Date(now).toISOString()}. Remind ${member.name} (member ${member.userId}): ${reminder.text}. Answer in this thread.`,
        `reminder:${reminder.id}:${reminder.attempts}`,
        [reminder.recipientId],
        // The turn is the asker's, with their own integrations: the text is theirs, not the recipient's.
        reminder.createdBy
      );
      if (!answer) {
        throw new Error("The agent gave no reminder.");
      }
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

const COLUMNS =
  "id, workspace_id AS workspaceId, thread_id AS threadId, recipient_id AS recipientId, created_by AS createdBy, text, due_at AS dueAt, time_zone AS timeZone, attempts, next_attempt_at AS nextAttemptAt, last_error AS lastError, delivered_at AS deliveredAt, cancelled_at AS cancelledAt";

function dueTime(at: string, timeZone: string, now: number): number {
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

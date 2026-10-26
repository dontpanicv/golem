import type { Database } from "bun:sqlite";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound } from "../platform/errors.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";

/** Something that needs a person's attention. It opens its thread, or its channel when `threadId` is null. */
export interface Notification {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId: string | null;
  readonly title: string;
  /** Plain text, without Markdown. */
  readonly text: string;
  readonly createdAt: number;
  readonly readAt: number | null;
}

export type NotificationInput = Pick<
  Notification,
  "workspaceId" | "channelId" | "threadId" | "title" | "text"
> & { readonly userId: string };

export interface Inbox {
  readonly notifications: readonly Notification[];
  /** The unread notifications of this workspace. */
  readonly unread: number;
  /** The unread notifications of all the person's workspaces, which the app icon shows. */
  readonly badge: number;
}

export type PushEnvironment = "sandbox" | "production";

/** A device of a person that gets pushes: an iPhone with the app. */
export interface PushDevice {
  readonly token: string;
  readonly environment: PushEnvironment;
}

export interface PushMessage {
  readonly notification: Notification;
  /** The notification's text, short enough for a push. */
  readonly body: string;
  readonly badge: number;
}

/** Sends one push; `gone` when the device takes no more pushes, such as after the app was removed. */
export type Push = (
  device: PushDevice,
  message: PushMessage
) => Promise<"sent" | "gone">;

export type NotificationWorkspaces = Pick<Workspaces, "list" | "requireMember">;

/** The newest notifications an inbox shows. */
const INBOX_SIZE = 100;
/** The most of an answer a notification keeps; the thread has all of it. */
const MAX_TEXT = 500;
/** The most of a notification's text a push shows. */
const MAX_PUSH_BODY = 180;
const COLUMNS =
  "id, workspace_id AS workspaceId, channel_id AS channelId, thread_id AS threadId, title, text, created_at AS createdAt, read_at AS readAt";
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;
const ENVIRONMENTS: readonly string[] = [
  "sandbox",
  "production",
] satisfies PushEnvironment[];

/**
 * The inbox of each person, and the pushes to their devices. A person who has the thread open on a screen sees what
 * happens there, so a notification for that thread is read at once and sends no push.
 */
export class Notifications {
  /** How many open screens of each person show each thread, by `<user> <thread>`. */
  private readonly watching = new Map<string, number>();

  constructor(
    private readonly database: Database,
    private readonly workspaces: NotificationWorkspaces,
    private readonly push: Push | null
  ) {}

  /**
   * Puts a notification in a person's inbox and pushes it to their devices, unless they have the thread open.
   *
   * @example
   * notifications.notify({ workspaceId, userId: anna.id, channelId, threadId, title: "Flights", text: answer });
   */
  notify(input: NotificationInput): Notification {
    const now = Date.now();
    const seen =
      input.threadId !== null &&
      this.watching.has(watchKey(input.userId, input.threadId));
    const notification: Notification = {
      id: Bun.randomUUIDv7(),
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      threadId: input.threadId,
      title: input.title,
      text: truncate(plainText(input.text), MAX_TEXT),
      createdAt: now,
      readAt: seen ? now : null,
    };
    this.database
      .query(
        "INSERT INTO notification (id, workspace_id, user_id, channel_id, thread_id, title, text, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        notification.id,
        notification.workspaceId,
        input.userId,
        notification.channelId,
        notification.threadId,
        notification.title,
        notification.text,
        notification.createdAt,
        notification.readAt
      );
    if (!seen) {
      this.send(input.userId, notification).catch((error: unknown) =>
        console.error("push failed", error)
      );
    }
    return notification;
  }

  inbox(workspaceId: string, user: User): Inbox {
    this.workspaces.requireMember(workspaceId, user);
    const notifications = this.database
      .query(
        `SELECT ${COLUMNS} FROM notification WHERE user_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(user.id, workspaceId, INBOX_SIZE) as Notification[];
    const { unread } = this.database
      .query(
        "SELECT count(*) AS unread FROM notification WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL"
      )
      .get(user.id, workspaceId) as { unread: number };
    return { notifications, unread, badge: this.badge(user) };
  }

  /** Marks one notification of the person read, or all of them in the workspace for a null `id`. */
  read(workspaceId: string, user: User, id: string | null): Inbox {
    this.workspaces.requireMember(workspaceId, user);
    const now = Date.now();
    if (id === null) {
      this.database
        .query(
          "UPDATE notification SET read_at = ? WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL"
        )
        .run(now, user.id, workspaceId);
    } else if (
      this.database
        .query(
          "UPDATE notification SET read_at = coalesce(read_at, ?) WHERE id = ? AND user_id = ? AND workspace_id = ?"
        )
        .run(now, id, user.id, workspaceId).changes === 0
    ) {
      throw notFound();
    }
    return this.inbox(workspaceId, user);
  }

  /**
   * Notes that a screen of the person shows a thread, and marks the thread's notifications read. Call the returned
   * function when the screen closes or goes to the background.
   */
  watch(user: User, threadId: string): () => void {
    const key = watchKey(user.id, threadId);
    this.watching.set(key, (this.watching.get(key) ?? 0) + 1);
    this.database
      .query(
        "UPDATE notification SET read_at = ? WHERE user_id = ? AND thread_id = ? AND read_at IS NULL"
      )
      .run(Date.now(), user.id, threadId);
    let watching = true;
    return () => {
      if (!watching) {
        return;
      }
      watching = false;
      const count = (this.watching.get(key) ?? 1) - 1;
      if (count === 0) {
        this.watching.delete(key);
      } else {
        this.watching.set(key, count);
      }
    };
  }

  /** Sends the person's pushes to a device; a device that another person used before sends them no more. */
  addDevice(user: User, token: unknown, environment: unknown): void {
    if (typeof token !== "string" || !DEVICE_TOKEN.test(token)) {
      throw new HttpError(400, "Send the device token in hex");
    }
    if (
      typeof environment !== "string" ||
      !ENVIRONMENTS.includes(environment)
    ) {
      throw new HttpError(400, "Environment must be sandbox or production");
    }
    const live = this.database
      .query(
        "SELECT user_id AS userId, environment FROM push_device WHERE token = ? AND deleted_at IS NULL"
      )
      .all(token) as { userId: string; environment: string }[];
    if (
      live.length === 1 &&
      live[0]!.userId === user.id &&
      live[0]!.environment === environment
    ) {
      return;
    }
    const now = Date.now();
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE push_device SET deleted_at = ? WHERE token = ? AND deleted_at IS NULL"
        )
        .run(now, token);
      this.database
        .query(
          "INSERT INTO push_device (id, user_id, token, environment, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(Bun.randomUUIDv7(), user.id, token, environment, now);
    })();
  }

  /** Sends no more pushes to a device of the person, such as when they sign out on it. */
  removeDevice(user: User, token: string): void {
    this.database
      .query(
        "UPDATE push_device SET deleted_at = ? WHERE token = ? AND user_id = ? AND deleted_at IS NULL"
      )
      .run(Date.now(), token, user.id);
  }

  private async send(userId: string, notification: Notification) {
    if (!this.push) {
      return;
    }
    const devices = this.database
      .query(
        "SELECT id, token, environment FROM push_device WHERE user_id = ? AND deleted_at IS NULL"
      )
      .all(userId) as (PushDevice & { id: string })[];
    if (devices.length === 0) {
      return;
    }
    const message: PushMessage = {
      notification,
      body: truncate(notification.text, MAX_PUSH_BODY),
      badge: this.badge({ id: userId, name: "", email: "" }),
    };
    await Promise.all(
      devices.map(async (device) => {
        if ((await this.push!(device, message)) === "gone") {
          this.database
            .query("UPDATE push_device SET deleted_at = ? WHERE id = ?")
            .run(Date.now(), device.id);
        }
      })
    );
  }

  private badge(user: User): number {
    const ids = this.workspaces.list(user).map((workspace) => workspace.id);
    if (ids.length === 0) {
      return 0;
    }
    const { unread } = this.database
      .query(
        `SELECT count(*) AS unread FROM notification WHERE user_id = ? AND read_at IS NULL AND workspace_id IN (${ids.map(() => "?").join(", ")})`
      )
      .get(user.id, ...ids) as { unread: number };
    return unread;
  }
}

/** Markdown as one line of plain text: link texts stay, pictures, markup, and tags go. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, length: number): string {
  return text.length <= length
    ? text
    : `${text.slice(0, length - 1).trimEnd()}…`;
}

function watchKey(userId: string, threadId: string): string {
  return `${userId} ${threadId}`;
}

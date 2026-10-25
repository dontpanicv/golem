import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Auth, User } from "./platform/auth.ts";
import { HttpError, notFound, required } from "./platform/errors.ts";
import type { ThreadRef, Threads } from "./threads.ts";

export interface Workspace {
  readonly id: string;
  readonly name: string;
}
export interface ThreadSummary {
  readonly channelId: string;
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}
export interface Channel {
  readonly id: string;
  readonly name: string;
  readonly threads: readonly ThreadSummary[];
}
export interface Member {
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly userId: string;
}

/**
 * Workspaces are isolated: every read and write goes through a membership check, and nothing crosses
 * workspaces except the LLM provider.
 */
export class Workspaces {
  constructor(
    private readonly database: Database,
    private readonly auth: Auth,
    private readonly threads: Threads
  ) {}

  list(user: User): Workspace[] {
    return this.database
      .query(
        "SELECT o.id, o.name FROM organization o JOIN member m ON m.organizationId = o.id WHERE m.userId = ? ORDER BY o.createdAt"
      )
      .all(user.id) as Workspace[];
  }

  /** The workspace if `user` is a member; otherwise not found, so other workspaces stay invisible. */
  get(workspaceId: string, user: User): Workspace {
    const workspace = this.database
      .query(
        "SELECT o.id, o.name FROM organization o JOIN member m ON m.organizationId = o.id WHERE o.id = ? AND m.userId = ?"
      )
      .get(workspaceId, user.id) as Workspace | null;
    if (!workspace) {
      throw notFound();
    }
    return workspace;
  }

  async create(user: User, name: string): Promise<Workspace> {
    const trimmed = required(name, "Name");
    const slug = `${
      trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "workspace"
    }-${randomUUID().slice(0, 8)}`;
    const created = await this.auth.api.createOrganization({
      body: { name: trimmed, slug, userId: user.id },
    });
    if (!created) {
      throw new HttpError(500, "Could not create the workspace");
    }
    const workspace = { id: created.id, name: created.name };
    this.createChannel(workspace.id, user, "general");
    return workspace;
  }

  channels(workspaceId: string, user: User): Channel[] {
    this.get(workspaceId, user);
    const channels = this.database
      .query(
        "SELECT id, name FROM channel WHERE workspace_id = ? ORDER BY created_at"
      )
      .all(workspaceId) as { id: string; name: string }[];
    const threads = this.database
      .query(
        "SELECT id, channel_id AS channelId, title, updated_at AS updatedAt FROM thread WHERE workspace_id = ? ORDER BY updated_at DESC"
      )
      .all(workspaceId) as ThreadSummary[];
    return channels.map((channel) => ({
      ...channel,
      threads: threads.filter((thread) => thread.channelId === channel.id),
    }));
  }

  createChannel(workspaceId: string, user: User, name: string): Channel {
    this.get(workspaceId, user);
    const slug = required(name, "Name")
      .toLowerCase()
      .replace(/^#/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (!slug) {
      throw new HttpError(400, "Use letters or numbers in the channel name");
    }
    const exists = this.database
      .query("SELECT 1 FROM channel WHERE workspace_id = ? AND name = ?")
      .get(workspaceId, slug);
    if (exists) {
      throw new HttpError(409, `#${slug} already exists`);
    }
    const channel = { id: randomUUID(), name: slug, threads: [] };
    this.database
      .query(
        "INSERT INTO channel (id, workspace_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(channel.id, workspaceId, slug, user.id, Date.now());
    return channel;
  }

  /** Starts a thread in a channel with its first message, which also names it. */
  async createThread(
    workspaceId: string,
    user: User,
    channelId: string,
    text: string
  ): Promise<ThreadSummary> {
    this.get(workspaceId, user);
    const message = required(text, "Message");
    const channel = this.database
      .query("SELECT 1 FROM channel WHERE id = ? AND workspace_id = ?")
      .get(channelId, workspaceId);
    if (!channel) {
      throw notFound();
    }
    const firstLine = message.split("\n")[0]!;
    const now = Date.now();
    const thread = {
      id: randomUUID(),
      channelId,
      title: firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine,
      updatedAt: now,
    };
    this.database
      .query(
        "INSERT INTO thread (id, workspace_id, channel_id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(thread.id, workspaceId, channelId, thread.title, user.id, now, now);
    await this.threads.send({ id: thread.id, workspaceId }, user, message);
    return thread;
  }

  /** The thread if `user` is a member of its workspace. */
  thread(threadId: string, user: User): ThreadSummary & ThreadRef {
    const thread = this.database
      .query(
        "SELECT t.id, t.workspace_id AS workspaceId, t.channel_id AS channelId, t.title, t.updated_at AS updatedAt FROM thread t JOIN member m ON m.organizationId = t.workspace_id WHERE t.id = ? AND m.userId = ?"
      )
      .get(threadId, user.id) as (ThreadSummary & ThreadRef) | null;
    if (!thread) {
      throw notFound();
    }
    return thread;
  }

  async send(threadId: string, user: User, text: string): Promise<void> {
    const thread = this.thread(threadId, user);
    await this.threads.send(thread, user, required(text, "Message"));
    this.database
      .query("UPDATE thread SET updated_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);
  }

  members(workspaceId: string, user: User): Member[] {
    this.get(workspaceId, user);
    return this.database
      .query(
        "SELECT u.id AS userId, u.name, u.email, m.role FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY m.createdAt"
      )
      .all(workspaceId) as Member[];
  }

  /** Adds someone who already has an account. */
  async addMember(
    workspaceId: string,
    user: User,
    email: string
  ): Promise<Member> {
    this.get(workspaceId, user);
    const person = this.database
      .query("SELECT id, name, email FROM user WHERE lower(email) = lower(?)")
      .get(required(email, "Email")) as {
      id: string;
      name: string;
      email: string;
    } | null;
    if (!person) {
      throw new HttpError(400, "Nobody has signed up with that email yet");
    }
    if (
      this.members(workspaceId, user).some(
        (member) => member.userId === person.id
      )
    ) {
      throw new HttpError(409, `${person.name} is already a member`);
    }
    await this.auth.api.addMember({
      body: { userId: person.id, organizationId: workspaceId, role: "member" },
    });
    return {
      userId: person.id,
      name: person.name,
      email: person.email,
      role: "member",
    };
  }
}

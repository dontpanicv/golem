import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Auth, User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";

/**
 * Whose private data a read sees besides what every member sees: a person's id, or `null` for none. A thread's agent
 * sees its thread's realm, so what it says in a channel every member reads never comes from a private channel.
 */
export type Realm = string | null;

/**
 * What identifies a thread: its id, its workspace, its conversation in that workspace's session, and, for an
 * orchestrator, the person it belongs to; `ownerId` is null for a thread of a channel. `realm` is the person of an
 * orchestrator or of a private channel, and null for a thread of a channel every member sees.
 */
export interface ThreadRef {
  readonly conversationId: number;
  readonly id: string;
  readonly ownerId: string | null;
  readonly realm: Realm;
  readonly workspaceId: string;
}
export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** The person's role: `owner` can rename and delete the workspace, `member` cannot. */
  readonly role: string;
}
export interface ThreadSummary {
  readonly channelId: string;
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly settledAt: number | null;
}
export interface Channel {
  readonly id: string;
  readonly name: string;
  /** The person a private channel belongs to, who alone sees it; null for a channel every member sees. */
  readonly ownerId: string | null;
  /** What the channel is for and what goes on in it, as an agent last wrote it. */
  readonly summary: string | null;
  /** An emoji for the channel, as the model last chose it. */
  readonly icon: string | null;
  readonly threads: readonly ThreadSummary[];
}
/** Facts about the family that its people write by hand; every agent of the workspace reads them. */
export interface Facts {
  readonly text: string;
}
export interface Member {
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly userId: string;
}

/** The longest facts text, so it stays a small part of every agent's instructions. */
const MAX_FACTS = 20_000;

/** Leaves out the rows of deleted workspaces. */
const LIVE =
  "workspace_id IN (SELECT id FROM organization WHERE deletedAt IS NULL)";
/** The columns of a thread as `ThreadSummary & ThreadRef`, from `thread t JOIN channel c`. */
const THREAD =
  "t.id, t.workspace_id AS workspaceId, t.conversation_id AS conversationId, t.channel_id AS channelId, t.title, t.updated_at AS updatedAt, t.settled_at AS settledAt, CASE WHEN t.orchestrator = 1 THEN t.created_by END AS ownerId, CASE WHEN t.orchestrator = 1 THEN t.created_by ELSE c.owner_id END AS realm";

/**
 * Workspaces are isolated: every read and write goes through a membership check, and nothing crosses
 * workspaces except the LLM provider.
 */
export class Workspaces {
  constructor(
    private readonly database: Database,
    private readonly auth: Auth,
    /** Called when someone joins a workspace, whose own integrations then reach its agents. */
    private readonly memberAdded: (workspaceId: string) => void = () =>
      undefined,
    /** Called when a channel is deleted, whose threads then leave the workspace's memory. */
    private readonly channelRemoved: (workspaceId: string) => void = () =>
      undefined
  ) {}

  list(user: User): Workspace[] {
    return this.database
      .query(
        "SELECT o.id, o.name, m.role FROM organization o JOIN member m ON m.organizationId = o.id WHERE m.userId = ? AND o.deletedAt IS NULL ORDER BY o.createdAt"
      )
      .all(user.id) as Workspace[];
  }

  /** Every workspace, for background work such as indexing that acts for no person. */
  ids(): string[] {
    return (
      this.database
        .query("SELECT id FROM organization WHERE deletedAt IS NULL")
        .all() as {
        id: string;
      }[]
    ).map((row) => row.id);
  }

  /** The workspace if `user` is a member; otherwise not found, so other workspaces stay invisible. */
  requireMember(workspaceId: string, user: User): Workspace {
    const workspace = this.database
      .query(
        "SELECT o.id, o.name, m.role FROM organization o JOIN member m ON m.organizationId = o.id WHERE o.id = ? AND m.userId = ? AND o.deletedAt IS NULL"
      )
      .get(workspaceId, user.id) as Workspace | null;
    if (!workspace) {
      throw notFound();
    }
    return workspace;
  }

  /** A workspace member for agent work that no person started, such as a routine run. */
  agentMember(workspaceId: string): User {
    const member = this.database
      .query(
        "SELECT u.id, u.name, u.email FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.createdAt LIMIT 1"
      )
      .get(workspaceId) as User | null;
    if (!member) {
      throw notFound();
    }
    this.requireMember(workspaceId, member);
    return member;
  }

  /** The workspace if `user` owns it; a member who is not an owner gets `403`. */
  requireOwner(workspaceId: string, user: User): Workspace {
    const workspace = this.requireMember(workspaceId, user);
    if (workspace.role !== "owner") {
      throw new HttpError(403, "Only an owner can do this");
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
    const workspace = { id: created.id, name: created.name, role: "owner" };
    this.createChannel(workspace.id, user, "general");
    return workspace;
  }

  rename(workspaceId: string, user: User, name: string): Workspace {
    const workspace = this.requireOwner(workspaceId, user);
    const trimmed = required(name, "Name");
    this.database
      .query("UPDATE organization SET name = ? WHERE id = ?")
      .run(trimmed, workspaceId);
    return { ...workspace, name: trimmed };
  }

  /** The channels the person sees: those of every member, and their own private ones. */
  channels(workspaceId: string, user: User): Channel[] {
    this.requireMember(workspaceId, user);
    return this.channelsIn(workspaceId, user.id);
  }

  /** A channel of the person's workspace; not found when it is deleted or in another workspace. */
  channel(workspaceId: string, channelId: string, user: User): Channel {
    const channel = this.channels(workspaceId, user).find(
      (candidate) => candidate.id === channelId
    );
    if (!channel) {
      throw notFound();
    }
    return channel;
  }

  /** The channels of a workspace that `realm` sees, with their threads, newest first, for agents. */
  channelsIn(workspaceId: string, realm: Realm): Channel[] {
    return this.allChannelsIn(workspaceId).filter(
      (channel) => channel.ownerId === null || channel.ownerId === realm
    );
  }

  /** Every channel of a workspace, private ones too, for background work that acts for no person. */
  allChannelsIn(workspaceId: string): Channel[] {
    const channels = this.database
      .query(
        `SELECT id, name, owner_id AS ownerId, summary, icon FROM channel WHERE workspace_id = ? AND deleted_at IS NULL AND ${LIVE} ORDER BY created_at, rowid`
      )
      .all(workspaceId) as Omit<Channel, "threads">[];
    const threads = this.database
      .query(
        "SELECT id, channel_id AS channelId, title, updated_at AS updatedAt, settled_at AS settledAt FROM thread WHERE workspace_id = ? AND orchestrator = 0 ORDER BY updated_at DESC"
      )
      .all(workspaceId) as ThreadSummary[];
    return channels.map((channel) => ({
      ...channel,
      threads: threads.filter((thread) => thread.channelId === channel.id),
    }));
  }

  /** Adds a channel; a `private` one is the person's own. */
  createChannel(
    workspaceId: string,
    user: User,
    name: string,
    isPrivate = false
  ): Channel {
    this.requireMember(workspaceId, user);
    return this.addChannel(
      workspaceId,
      name,
      user.id,
      isPrivate ? user.id : null
    );
  }

  /**
   * Adds a channel to a workspace; `createdBy` is a person's id, or `golem` for a channel an agent made, and `ownerId`
   * the person of a private channel. Names are unique in the workspace, private ones too.
   */
  addChannel(
    workspaceId: string,
    name: string,
    createdBy: string,
    ownerId: Realm
  ): Channel {
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
    const channel = {
      id: randomUUID(),
      name: slug,
      ownerId,
      summary: null,
      icon: null,
      threads: [],
    };
    this.database
      .query(
        "INSERT INTO channel (id, workspace_id, name, owner_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(channel.id, workspaceId, slug, ownerId, createdBy, Date.now());
    return channel;
  }

  /** Deletes a channel that the person sees; see `removeChannel`. */
  deleteChannel(workspaceId: string, user: User, channelId: string): Channel {
    this.requireMember(workspaceId, user);
    return this.removeChannel(workspaceId, channelId, user.id);
  }

  /**
   * Deletes a channel that `realm` sees, for an agent that acts for it. Nothing is removed: the channel and its threads
   * stay in the database, hidden. Its name gets `~<id>`, which no channel name has, so a new channel can take the
   * name. The orchestrators move to the first other channel that every member sees, so a workspace keeps one such
   * channel at least.
   */
  removeChannel(workspaceId: string, channelId: string, realm: Realm): Channel {
    const channel = this.channelsIn(workspaceId, realm).find(
      (candidate) => candidate.id === channelId
    );
    if (!channel) {
      throw notFound();
    }
    const next = this.channelsIn(workspaceId, null).find(
      (candidate) => candidate.id !== channelId
    );
    if (!next) {
      throw new HttpError(409, "A workspace keeps one channel at least");
    }
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE thread SET channel_id = ? WHERE channel_id = ? AND orchestrator = 1"
        )
        .run(next.id, channelId);
      this.database
        .query(
          "UPDATE channel SET deleted_at = ?, name = name || '~' || id WHERE id = ?"
        )
        .run(Date.now(), channelId);
    })();
    this.channelRemoved(workspaceId);
    return channel;
  }

  /** Replaces the summary of a channel, for an agent that acts for the workspace. */
  setChannelSummary(
    workspaceId: string,
    channelId: string,
    summary: string
  ): void {
    this.database
      .query(
        "UPDATE channel SET summary = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL"
      )
      .run(summary.trim() || null, channelId, workspaceId);
  }

  /** Replaces the emoji of a channel, for an agent that acts for the workspace. */
  setChannelIcon(workspaceId: string, channelId: string, icon: string): void {
    this.database
      .query(
        "UPDATE channel SET icon = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL"
      )
      .run(icon, channelId, workspaceId);
  }

  /** The facts that the people of the workspace wrote, such as names, birthdays, and places. */
  facts(workspaceId: string, user: User): Facts {
    this.requireMember(workspaceId, user);
    return { text: this.factsOf(workspaceId) };
  }

  /** The facts of a workspace, for its agents; empty when nobody wrote them. */
  factsOf(workspaceId: string): string {
    const row = this.database
      .query("SELECT text FROM workspace_facts WHERE workspace_id = ?")
      .get(workspaceId) as { text: string } | null;
    return row?.text ?? "";
  }

  /** Replaces the facts of the workspace; every member can write them. */
  setFacts(workspaceId: string, user: User, text: string): Facts {
    this.requireMember(workspaceId, user);
    if (typeof text !== "string" || text.length > MAX_FACTS) {
      throw new HttpError(
        400,
        `Write the facts as text of at most ${MAX_FACTS} characters`
      );
    }
    this.database
      .query(
        "INSERT INTO workspace_facts (workspace_id, text, changed_by, changed_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id) DO UPDATE SET text = excluded.text, changed_by = excluded.changed_by, changed_at = excluded.changed_at"
      )
      .run(workspaceId, text.trim(), user.id, Date.now());
    return { text: text.trim() };
  }

  /**
   * Adds a thread to a channel of the workspace. `Threads` checks who asks, names the thread, and creates its
   * conversation; `createdBy` is a person's id, or `golem` for a thread an agent started. Each person has at most one
   * `orchestrator` thread in a workspace, their own.
   */
  registerThread(
    workspaceId: string,
    thread: {
      readonly channelId: string;
      readonly conversationId: number;
      readonly createdBy: string;
      readonly id: string;
      readonly orchestrator?: boolean;
      readonly title: string;
    }
  ): ThreadSummary {
    const { channelId, conversationId, title } = thread;
    const channel = this.database
      .query(
        "SELECT 1 FROM channel WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL"
      )
      .get(channelId, workspaceId);
    if (!channel) {
      throw notFound();
    }
    const now = Date.now();
    this.database
      .query(
        "INSERT INTO thread (id, workspace_id, channel_id, title, conversation_id, created_by, created_at, updated_at, orchestrator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        thread.id,
        workspaceId,
        channelId,
        title,
        conversationId,
        thread.createdBy,
        now,
        now,
        thread.orchestrator ? 1 : 0
      );
    return { id: thread.id, channelId, title, updatedAt: now, settledAt: null };
  }

  /**
   * The thread if `user` is a member of its workspace; an orchestrator, or a thread of a private channel, only for its
   * own person.
   */
  thread(threadId: string, user: User): ThreadSummary & ThreadRef {
    const thread = this.database
      .query(
        `SELECT ${THREAD} FROM thread t JOIN member m ON m.organizationId = t.workspace_id JOIN channel c ON c.id = t.channel_id AND c.deleted_at IS NULL WHERE t.id = ? AND m.userId = ? AND (t.orchestrator = 0 OR t.created_by = m.userId) AND (c.owner_id IS NULL OR c.owner_id = m.userId) AND t.${LIVE}`
      )
      .get(threadId, user.id) as (ThreadSummary & ThreadRef) | null;
    if (!thread) {
      throw notFound();
    }
    return thread;
  }

  /**
   * The threads of a workspace that `realm` sees: those of its channels, and the orchestrator of its person. Those of
   * deleted channels are left out.
   */
  threadsIn(workspaceId: string, realm: Realm): (ThreadSummary & ThreadRef)[] {
    return this.allThreadsIn(workspaceId).filter(
      (thread) => thread.realm === null || thread.realm === realm
    );
  }

  /**
   * Every thread of a workspace, every person's orchestrator and private channels too, but those of deleted channels,
   * for background work that acts for no person.
   */
  allThreadsIn(workspaceId: string): (ThreadSummary & ThreadRef)[] {
    return this.database
      .query(
        `SELECT ${THREAD} FROM thread t JOIN channel c ON c.id = t.channel_id AND c.deleted_at IS NULL WHERE t.workspace_id = ? AND t.${LIVE}`
      )
      .all(workspaceId) as (ThreadSummary & ThreadRef)[];
  }

  /** The thread of a conversation of the workspace, for the tools of its agent; null for one no thread has. */
  threadOf(
    workspaceId: string,
    conversationId: number
  ): (ThreadSummary & ThreadRef) | null {
    return this.database
      .query(
        `SELECT ${THREAD} FROM thread t JOIN channel c ON c.id = t.channel_id AND c.deleted_at IS NULL WHERE t.workspace_id = ? AND t.conversation_id = ? AND t.${LIVE}`
      )
      .get(workspaceId, conversationId) as (ThreadSummary & ThreadRef) | null;
  }

  /** The person's thread of the workspace that never ends, if they have one yet; `Threads.orchestrator` makes it. */
  orchestratorOf(
    workspaceId: string,
    personId: string
  ): (ThreadSummary & ThreadRef) | null {
    return this.database
      .query(
        "SELECT id, workspace_id AS workspaceId, conversation_id AS conversationId, channel_id AS channelId, title, updated_at AS updatedAt, settled_at AS settledAt, created_by AS ownerId, created_by AS realm FROM thread WHERE workspace_id = ? AND created_by = ? AND orchestrator = 1"
      )
      .get(workspaceId, personId) as (ThreadSummary & ThreadRef) | null;
  }

  renameThread(threadId: string, title: string): void {
    this.database
      .query("UPDATE thread SET title = ? WHERE id = ?")
      .run(title, threadId);
  }

  /** Moves the thread up in its channel, after a new message. */
  touchThread(threadId: string): void {
    this.database
      .query("UPDATE thread SET updated_at = ? WHERE id = ?")
      .run(Date.now(), threadId);
  }

  /** Moves a thread into or out of its channel's settled list. */
  setThreadSettled(
    workspaceId: string,
    threadId: string,
    user: User,
    settled: boolean
  ): ThreadSummary {
    this.requireMember(workspaceId, user);
    const thread = this.thread(threadId, user);
    if (thread.workspaceId !== workspaceId) {
      throw notFound();
    }
    if (thread.ownerId !== null) {
      throw new HttpError(400, "This thread stays open");
    }
    if ((thread.settledAt !== null) === settled) {
      return thread;
    }
    this.database
      .query("UPDATE thread SET settled_at = ? WHERE id = ?")
      .run(settled ? Date.now() : null, threadId);
    return this.thread(threadId, user);
  }

  members(workspaceId: string, user: User): Member[] {
    this.requireMember(workspaceId, user);
    return this.database
      .query(
        "SELECT u.id AS userId, u.name, u.email, m.role FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY m.createdAt"
      )
      .all(workspaceId) as Member[];
  }

  /** Adds someone who already has an account, for an owner of the workspace. */
  async addMember(
    workspaceId: string,
    user: User,
    email: string
  ): Promise<Member> {
    this.requireOwner(workspaceId, user);
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
    this.memberAdded(workspaceId);
    return {
      userId: person.id,
      name: person.name,
      email: person.email,
      role: "member",
    };
  }
}

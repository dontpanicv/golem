import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ProfilePicture, ProfilePictures } from "../accounts/accounts.ts";
import type { Auth, User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";

/**
 * Whose private data a read sees besides what every member sees: a person's id, or `null` for none. A chat's agent
 * sees its chat's realm, so what it says in a topic every member reads never comes from a private topic.
 */
export type Realm = string | null;

/**
 * What identifies a chat: its id, its workspace, its conversation in that workspace's session, and, for an
 * orchestrator, the person it belongs to; `ownerId` is null for a chat of a topic. `realm` is the person of an
 * orchestrator or of a private topic, and null for a chat of a topic every member sees.
 */
export interface ChatRef {
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
export interface ChatSummary {
  readonly topicId: string;
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly settledAt: number | null;
}
export interface Topic {
  readonly id: string;
  readonly name: string;
  /** The person a private topic belongs to, who alone sees it; null for a topic every member sees. */
  readonly ownerId: string | null;
  /** What the topic is for and what goes on in it, as an agent last wrote it. */
  readonly summary: string | null;
  /** An emoji for the topic, as the model last chose it. */
  readonly icon: string | null;
  readonly chats: readonly ChatSummary[];
}
/** Facts about the family that its people write by hand; every agent of the workspace reads them. */
export interface Facts {
  readonly text: string;
}
export interface Member {
  readonly email: string;
  readonly name: string;
  /** The address of the person's profile picture, or null for none. */
  readonly picture: string | null;
  readonly role: string;
  readonly userId: string;
}

/** The longest facts text, so it stays a small part of every agent's instructions. */
const MAX_FACTS = 20_000;

/** Leaves out the rows of deleted workspaces. */
const LIVE =
  "workspace_id IN (SELECT id FROM organization WHERE deletedAt IS NULL)";
/** The columns of a chat as `ChatSummary & ChatRef`, from `chat t JOIN topic c`. */
const CHAT =
  "t.id, t.workspace_id AS workspaceId, t.conversation_id AS conversationId, t.topic_id AS topicId, t.title, t.updated_at AS updatedAt, t.settled_at AS settledAt, CASE WHEN t.orchestrator = 1 THEN t.created_by END AS ownerId, CASE WHEN t.orchestrator = 1 THEN t.created_by ELSE c.owner_id END AS realm";

/**
 * Workspaces are isolated: every read and write goes through a membership check, and nothing crosses
 * workspaces except the LLM provider.
 */
export class Workspaces {
  constructor(
    private readonly database: Database,
    private readonly auth: Auth,
    private readonly pictures: ProfilePictures,
    /** Called when someone joins a workspace, whose own integrations then reach its agents. */
    private readonly memberAdded: (workspaceId: string) => void = () =>
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
    this.createTopic(workspace.id, user, "general");
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

  /** The topics the person sees: those of every member, and their own private ones. */
  topics(workspaceId: string, user: User): Topic[] {
    this.requireMember(workspaceId, user);
    return this.topicsIn(workspaceId, user.id);
  }

  /** A topic of the person's workspace; not found when it is deleted or in another workspace. */
  topic(workspaceId: string, topicId: string, user: User): Topic {
    const topic = this.topics(workspaceId, user).find(
      (candidate) => candidate.id === topicId
    );
    if (!topic) {
      throw notFound();
    }
    return topic;
  }

  /** The topics of a workspace that `realm` sees, with their chats, newest first, for agents. */
  topicsIn(workspaceId: string, realm: Realm): Topic[] {
    return this.allTopicsIn(workspaceId).filter(
      (topic) => topic.ownerId === null || topic.ownerId === realm
    );
  }

  /** Every topic of a workspace, private ones too, for background work that acts for no person. */
  allTopicsIn(workspaceId: string): Topic[] {
    const topics = this.database
      .query(
        `SELECT id, name, owner_id AS ownerId, summary, icon FROM topic WHERE workspace_id = ? AND deleted_at IS NULL AND ${LIVE} ORDER BY created_at, rowid`
      )
      .all(workspaceId) as Omit<Topic, "chats">[];
    const chats = this.database
      .query(
        "SELECT id, topic_id AS topicId, title, updated_at AS updatedAt, settled_at AS settledAt FROM chat WHERE workspace_id = ? AND orchestrator = 0 ORDER BY updated_at DESC"
      )
      .all(workspaceId) as ChatSummary[];
    return topics.map((topic) => ({
      ...topic,
      chats: chats.filter((chat) => chat.topicId === topic.id),
    }));
  }

  /** Adds a topic; a `private` one is the person's own. */
  createTopic(
    workspaceId: string,
    user: User,
    name: string,
    isPrivate = false
  ): Topic {
    this.requireMember(workspaceId, user);
    return this.addTopic(
      workspaceId,
      name,
      user.id,
      isPrivate ? user.id : null
    );
  }

  /**
   * Adds a topic to a workspace; `createdBy` is a person's id, or `golem` for a topic an agent made, and `ownerId`
   * the person of a private topic. Names are unique in the workspace, private ones too.
   */
  addTopic(
    workspaceId: string,
    name: string,
    createdBy: string,
    ownerId: Realm
  ): Topic {
    const slug = this.freeTopicName(workspaceId, name);
    const topic = {
      id: randomUUID(),
      name: slug,
      ownerId,
      summary: null,
      icon: null,
      chats: [],
    };
    this.database
      .query(
        "INSERT INTO topic (id, workspace_id, name, owner_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(topic.id, workspaceId, slug, ownerId, createdBy, Date.now());
    return topic;
  }

  /** Gives a topic that the person sees a new name; names stay unique in the workspace. */
  renameTopic(
    workspaceId: string,
    user: User,
    topicId: string,
    name: string
  ): Topic {
    const topic = this.topic(workspaceId, topicId, user);
    const slug = this.freeTopicName(workspaceId, name, topicId);
    this.database
      .query("UPDATE topic SET name = ? WHERE id = ?")
      .run(slug, topicId);
    return { ...topic, name: slug };
  }

  /**
   * A topic name as Golem keeps it: lowercase letters, also with diacritics, and numbers, with `-` between words.
   * `409` when another topic of the workspace has it.
   */
  private freeTopicName(
    workspaceId: string,
    name: string,
    topicId = ""
  ): string {
    const slug = required(name, "Name")
      .normalize("NFC")
      .toLowerCase()
      .replace(/^#/, "")
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "");
    if (!slug) {
      throw new HttpError(400, "Use letters or numbers in the topic name");
    }
    const exists = this.database
      .query(
        "SELECT 1 FROM topic WHERE workspace_id = ? AND name = ? AND id != ?"
      )
      .get(workspaceId, slug, topicId);
    if (exists) {
      throw new HttpError(409, `#${slug} already exists`);
    }
    return slug;
  }

  /**
   * Deletes a topic that `realm` sees, once `Chats.merge` moved all it held to another topic. Nothing is removed: the topic and its chats
   * stay in the database, hidden. Its name gets `~<id>`, which no topic name has, so a new topic can take the
   * name. The orchestrators move to the first other topic that every member sees, so a workspace keeps one such
   * topic at least.
   */
  removeTopic(workspaceId: string, topicId: string, realm: Realm): Topic {
    const topic = this.topicsIn(workspaceId, realm).find(
      (candidate) => candidate.id === topicId
    );
    if (!topic) {
      throw notFound();
    }
    const next = this.topicsIn(workspaceId, null).find(
      (candidate) => candidate.id !== topicId
    );
    if (!next) {
      throw new HttpError(409, "A workspace keeps one topic at least");
    }
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE chat SET topic_id = ? WHERE topic_id = ? AND orchestrator = 1"
        )
        .run(next.id, topicId);
      this.database
        .query(
          "UPDATE topic SET deleted_at = ?, name = name || '~' || id WHERE id = ?"
        )
        .run(Date.now(), topicId);
    })();
    return topic;
  }

  /** Replaces the summary of a topic, for an agent that acts for the workspace. */
  setTopicSummary(workspaceId: string, topicId: string, summary: string): void {
    this.database
      .query(
        "UPDATE topic SET summary = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL"
      )
      .run(summary.trim() || null, topicId, workspaceId);
  }

  /** Replaces the emoji of a topic, for an agent that acts for the workspace. */
  setTopicIcon(workspaceId: string, topicId: string, icon: string): void {
    this.database
      .query(
        "UPDATE topic SET icon = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL"
      )
      .run(icon, topicId, workspaceId);
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
   * Adds a chat to a topic of the workspace. `Chats` checks who asks, names the chat, and creates its
   * conversation; `createdBy` is a person's id, or `golem` for a chat an agent started. Each person has at most one
   * `orchestrator` chat in a workspace, their own.
   */
  registerChat(
    workspaceId: string,
    chat: {
      readonly topicId: string;
      readonly conversationId: number;
      readonly createdBy: string;
      readonly id: string;
      readonly orchestrator?: boolean;
      readonly title: string;
    }
  ): ChatSummary {
    const { topicId, conversationId, title } = chat;
    const topic = this.database
      .query(
        "SELECT 1 FROM topic WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL"
      )
      .get(topicId, workspaceId);
    if (!topic) {
      throw notFound();
    }
    const now = Date.now();
    this.database
      .query(
        "INSERT INTO chat (id, workspace_id, topic_id, title, conversation_id, created_by, created_at, updated_at, orchestrator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        chat.id,
        workspaceId,
        topicId,
        title,
        conversationId,
        chat.createdBy,
        now,
        now,
        chat.orchestrator ? 1 : 0
      );
    return { id: chat.id, topicId, title, updatedAt: now, settledAt: null };
  }

  /**
   * The chat if `user` is a member of its workspace; an orchestrator, or a chat of a private topic, only for its
   * own person.
   */
  chat(chatId: string, user: User): ChatSummary & ChatRef {
    const chat = this.database
      .query(
        `SELECT ${CHAT} FROM chat t JOIN member m ON m.organizationId = t.workspace_id JOIN topic c ON c.id = t.topic_id AND c.deleted_at IS NULL WHERE t.id = ? AND m.userId = ? AND (t.orchestrator = 0 OR t.created_by = m.userId) AND (c.owner_id IS NULL OR c.owner_id = m.userId) AND t.${LIVE}`
      )
      .get(chatId, user.id) as (ChatSummary & ChatRef) | null;
    if (!chat) {
      throw notFound();
    }
    return chat;
  }

  /**
   * The chats of a workspace that `realm` sees: those of its topics, and the orchestrator of its person. Those of
   * deleted topics are left out.
   */
  chatsIn(workspaceId: string, realm: Realm): (ChatSummary & ChatRef)[] {
    return this.allChatsIn(workspaceId).filter(
      (chat) => chat.realm === null || chat.realm === realm
    );
  }

  /**
   * Every chat of a workspace, every person's orchestrator and private topics too, but those of deleted topics,
   * for background work that acts for no person.
   */
  allChatsIn(workspaceId: string): (ChatSummary & ChatRef)[] {
    return this.database
      .query(
        `SELECT ${CHAT} FROM chat t JOIN topic c ON c.id = t.topic_id AND c.deleted_at IS NULL WHERE t.workspace_id = ? AND t.${LIVE}`
      )
      .all(workspaceId) as (ChatSummary & ChatRef)[];
  }

  /** The chat of a conversation of the workspace, for the tools of its agent; null for one no chat has. */
  chatOf(
    workspaceId: string,
    conversationId: number
  ): (ChatSummary & ChatRef) | null {
    return this.database
      .query(
        `SELECT ${CHAT} FROM chat t JOIN topic c ON c.id = t.topic_id AND c.deleted_at IS NULL WHERE t.workspace_id = ? AND t.conversation_id = ? AND t.${LIVE}`
      )
      .get(workspaceId, conversationId) as (ChatSummary & ChatRef) | null;
  }

  /** The person's chat of the workspace that never ends, if they have one yet; `Chats.orchestrator` makes it. */
  orchestratorOf(
    workspaceId: string,
    personId: string
  ): (ChatSummary & ChatRef) | null {
    return this.database
      .query(
        "SELECT id, workspace_id AS workspaceId, conversation_id AS conversationId, topic_id AS topicId, title, updated_at AS updatedAt, settled_at AS settledAt, created_by AS ownerId, created_by AS realm FROM chat WHERE workspace_id = ? AND created_by = ? AND orchestrator = 1"
      )
      .get(workspaceId, personId) as (ChatSummary & ChatRef) | null;
  }

  renameChat(chatId: string, title: string): void {
    this.database
      .query("UPDATE chat SET title = ? WHERE id = ?")
      .run(title, chatId);
  }

  /** Moves the chat up in its topic, after a new message. */
  /** Marks new activity in a chat; a settled chat opens again, so a new message never hides in the settled list. */
  touchChat(chatId: string): void {
    this.database
      .query("UPDATE chat SET updated_at = ?, settled_at = NULL WHERE id = ?")
      .run(Date.now(), chatId);
  }

  /**
   * Moves a chat of a topic that `realm` sees to another topic it sees; `Chats.move` moves what goes with it.
   * Only the person who started a chat moves it into a private topic, which takes it from the others.
   */
  moveChat(
    workspaceId: string,
    realm: Realm,
    personId: string,
    chatId: string,
    topicId: string
  ): {
    readonly chat: ChatSummary & ChatRef;
    readonly from: Topic;
    readonly to: Topic;
  } {
    const chat = this.chatsIn(workspaceId, realm).find(
      (candidate) => candidate.id === chatId
    );
    const topics = this.topicsIn(workspaceId, realm);
    const from = topics.find((candidate) => candidate.id === chat?.topicId);
    const to = topics.find((candidate) => candidate.id === topicId);
    if (!(chat && from && to)) {
      throw notFound();
    }
    if (chat.ownerId !== null) {
      throw new HttpError(400, "This chat stays where it is");
    }
    if (from.id === to.id) {
      return { chat, from, to };
    }
    const { createdBy } = this.database
      .query("SELECT created_by AS createdBy FROM chat WHERE id = ?")
      .get(chatId) as { createdBy: string };
    if (to.ownerId !== null && createdBy !== personId) {
      throw new HttpError(
        403,
        "Only the person who started a chat moves it into a private topic"
      );
    }
    this.database
      .query("UPDATE chat SET topic_id = ? WHERE id = ?")
      .run(to.id, chatId);
    return {
      chat: { ...chat, topicId: to.id, realm: to.ownerId },
      from,
      to,
    };
  }

  /** Moves a chat into or out of its topic's settled list. */
  setChatSettled(
    workspaceId: string,
    chatId: string,
    user: User,
    settled: boolean
  ): ChatSummary {
    this.requireMember(workspaceId, user);
    const chat = this.chat(chatId, user);
    if (chat.workspaceId !== workspaceId) {
      throw notFound();
    }
    if (chat.ownerId !== null) {
      throw new HttpError(400, "This chat stays open");
    }
    if ((chat.settledAt !== null) === settled) {
      return chat;
    }
    this.database
      .query("UPDATE chat SET settled_at = ? WHERE id = ?")
      .run(settled ? Date.now() : null, chatId);
    return this.chat(chatId, user);
  }

  members(workspaceId: string, user: User): Member[] {
    this.requireMember(workspaceId, user);
    const members = this.database
      .query(
        "SELECT u.id AS userId, u.name, u.email, m.role FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY m.createdAt"
      )
      .all(workspaceId) as Omit<Member, "picture">[];
    const pictures = this.pictures.ids(members.map((member) => member.userId));
    return members.map((member) => ({
      ...member,
      picture: picturePath(pictures.get(member.userId)),
    }));
  }

  /** The address of the person's own profile picture, or null for none. */
  pictureOf(user: User): string | null {
    return picturePath(this.pictures.ids([user.id]).get(user.id));
  }

  /** A profile picture of the person or of someone who shares a workspace with them; otherwise not found. */
  picture(pictureId: string, user: User): ProfilePicture {
    const picture = this.pictures.get(pictureId);
    const shared =
      picture.userId === user.id ||
      this.database
        .query(
          "SELECT 1 FROM member a JOIN member b ON b.organizationId = a.organizationId JOIN organization o ON o.id = a.organizationId WHERE a.userId = ? AND b.userId = ? AND o.deletedAt IS NULL"
        )
        .get(user.id, picture.userId) !== null;
    if (!shared) {
      throw notFound();
    }
    return picture;
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
      picture: this.pictureOf(person),
      role: "member",
    };
  }
}

function picturePath(id: string | undefined): string | null {
  return id ? `/api/v1/pictures/${id}` : null;
}

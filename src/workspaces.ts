import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Auth, User } from "./auth.ts";
import type { Secrets } from "./secrets.ts";
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
export interface CredentialSummary {
  readonly createdAt: number;
  readonly id: string;
  readonly label: string;
  readonly mine: boolean;
  readonly ownerName: string;
  readonly shared: boolean;
}
export interface Integration {
  readonly credentials: readonly CredentialSummary[];
  readonly enabled: boolean;
  readonly id: string;
  readonly name: string;
  readonly secretLabel: string;
}
/** What an agent run may use: the secrets of enabled integrations that are the user's own or shared. */
export interface UsableCredential {
  readonly integration: string;
  readonly label: string;
  readonly secret: string;
}

/** Integrations whose tools agents can use. Token-based for now; OAuth ones arrive with Google sign-in. */
export const integrationCatalog = [
  { id: "github", name: "GitHub", secretLabel: "Personal access token" },
  { id: "linear", name: "Linear", secretLabel: "API key" },
  {
    id: "home-assistant",
    name: "Home Assistant",
    secretLabel: "Long-lived access token",
  },
] as const;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const notFound = () => new HttpError(404, "Not found");

/**
 * Workspaces are isolated: every read and write goes through a membership check, and nothing crosses
 * workspaces except the LLM provider.
 */
export class Workspaces {
  constructor(
    private readonly database: Database,
    private readonly auth: Auth,
    private readonly secrets: Secrets,
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

  integrations(workspaceId: string, user: User): Integration[] {
    this.get(workspaceId, user);
    const enabled = new Set(
      (
        this.database
          .query(
            "SELECT integration FROM integration_setting WHERE workspace_id = ? AND user_id = ? AND enabled = 1"
          )
          .all(workspaceId, user.id) as { integration: string }[]
      ).map((row) => row.integration)
    );
    const credentials = this.database
      .query(
        "SELECT c.id, c.integration, c.label, c.shared, c.owner_id AS ownerId, u.name AS ownerName, c.created_at AS createdAt FROM credential c JOIN user u ON u.id = c.owner_id WHERE c.workspace_id = ? AND (c.shared = 1 OR c.owner_id = ?) ORDER BY c.created_at"
      )
      .all(workspaceId, user.id) as {
      id: string;
      integration: string;
      label: string;
      shared: number;
      ownerId: string;
      ownerName: string;
      createdAt: number;
    }[];
    return integrationCatalog.map((integration) => ({
      ...integration,
      enabled: enabled.has(integration.id),
      credentials: credentials
        .filter((credential) => credential.integration === integration.id)
        .map(({ integration: _, ownerId, shared, ...credential }) => ({
          ...credential,
          shared: shared === 1,
          mine: ownerId === user.id,
        })),
    }));
  }

  setEnabled(
    workspaceId: string,
    user: User,
    integrationId: string,
    enabled: boolean
  ): Integration {
    this.get(workspaceId, user);
    catalogEntry(integrationId);
    this.database
      .query(
        "INSERT INTO integration_setting (workspace_id, user_id, integration, enabled) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, user_id, integration) DO UPDATE SET enabled = excluded.enabled"
      )
      .run(workspaceId, user.id, integrationId, enabled ? 1 : 0);
    return this.integrations(workspaceId, user).find(
      (integration) => integration.id === integrationId
    )!;
  }

  addCredential(
    workspaceId: string,
    user: User,
    integrationId: string,
    input: { label: string; secret: string; shared: boolean }
  ): CredentialSummary {
    this.get(workspaceId, user);
    catalogEntry(integrationId);
    const credential = {
      id: randomUUID(),
      label: required(input.label, "Label"),
      shared: input.shared,
      mine: true,
      ownerName: user.name,
      createdAt: Date.now(),
    };
    this.database
      .query(
        "INSERT INTO credential (id, workspace_id, integration, owner_id, label, shared, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        credential.id,
        workspaceId,
        integrationId,
        user.id,
        credential.label,
        input.shared ? 1 : 0,
        this.secrets.encrypt(required(input.secret, "Secret")),
        credential.createdAt
      );
    return credential;
  }

  deleteCredential(
    workspaceId: string,
    user: User,
    credentialId: string
  ): void {
    this.get(workspaceId, user);
    const { changes } = this.database
      .query(
        "DELETE FROM credential WHERE id = ? AND workspace_id = ? AND owner_id = ?"
      )
      .run(credentialId, workspaceId, user.id);
    if (changes === 0) {
      throw notFound();
    }
  }

  /** Secrets an agent acting for `user` may use in this workspace. */
  usableCredentials(workspaceId: string, user: User): UsableCredential[] {
    const rows = this.database
      .query(
        "SELECT c.integration, c.label, c.secret FROM credential c JOIN integration_setting s ON s.workspace_id = c.workspace_id AND s.integration = c.integration AND s.user_id = ? AND s.enabled = 1 WHERE c.workspace_id = ? AND (c.shared = 1 OR c.owner_id = ?) ORDER BY c.owner_id = ? DESC, c.created_at"
      )
      .all(user.id, workspaceId, user.id, user.id) as {
      integration: string;
      label: string;
      secret: Uint8Array;
    }[];
    return rows.map((row) => ({
      integration: row.integration,
      label: row.label,
      secret: this.secrets.decrypt(row.secret),
    }));
  }
}

function catalogEntry(integrationId: string) {
  const entry = integrationCatalog.find(
    (integration) => integration.id === integrationId
  );
  if (!entry) {
    throw notFound();
  }
  return entry;
}

function required(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new HttpError(400, `${field} is required`);
  }
  return text;
}

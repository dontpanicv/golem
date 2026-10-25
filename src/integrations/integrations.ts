import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { User } from "../platform/auth.ts";
import { notFound, required } from "../platform/errors.ts";
import type { Secrets } from "../platform/secrets.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";

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

/**
 * What agents may use in a workspace: each person turns integrations on for themselves, and adds credentials that
 * are their own or shared with the workspace. Secrets never leave the server.
 */
export class Integrations {
  constructor(
    private readonly database: Database,
    private readonly secrets: Secrets,
    private readonly workspaces: Workspaces
  ) {}

  list(workspaceId: string, user: User): Integration[] {
    this.workspaces.requireMember(workspaceId, user);
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
    this.workspaces.requireMember(workspaceId, user);
    catalogEntry(integrationId);
    this.database
      .query(
        "INSERT INTO integration_setting (workspace_id, user_id, integration, enabled) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, user_id, integration) DO UPDATE SET enabled = excluded.enabled"
      )
      .run(workspaceId, user.id, integrationId, enabled ? 1 : 0);
    return this.list(workspaceId, user).find(
      (integration) => integration.id === integrationId
    )!;
  }

  addCredential(
    workspaceId: string,
    user: User,
    integrationId: string,
    input: { label: string; secret: string; shared: boolean }
  ): CredentialSummary {
    this.workspaces.requireMember(workspaceId, user);
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
    this.workspaces.requireMember(workspaceId, user);
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

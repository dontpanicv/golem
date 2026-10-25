import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { User } from "../platform/auth.ts";
import { notFound, required } from "../platform/errors.ts";
import type { Secrets } from "../platform/secrets.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";

export interface CredentialSummary {
  readonly createdAt: number;
  readonly id: string;
  readonly label: string;
  readonly ownerName: string;
}
export interface Integration {
  readonly credentials: readonly CredentialSummary[];
  readonly id: string;
  readonly name: string;
  readonly secretLabel: string;
}

/**
 * A tool of a connector, which agents call in threads and routine scripts call as `tools.<name>(args)`. It gets the
 * secret of the workspace's credential for its integration; the secret never reaches the agent or the script.
 */
export interface ConnectorTool<Parameters extends TSchema = TSchema> {
  /** Starts with the integration, such as `school_messages`. */
  readonly name: string;
  readonly description: string;
  readonly parameters: Parameters;
  /** Returns JSON: agents read it as text, and scripts get the value. */
  // biome-ignore lint/style/useConsistentMethodSignatures: a method keeps a tool with typed arguments a ConnectorTool.
  execute(
    args: Static<Parameters>,
    secret: string,
    signal: AbortSignal | undefined
  ): Promise<unknown>;
}

/** An outside system that agents use through the tools of its connector, with a secret from Workspace settings. */
export interface Connector {
  readonly id: string;
  readonly name: string;
  readonly secretLabel: string;
  readonly tools: readonly ConnectorTool[];
}

/** A connector tool of one workspace, with its credential applied. */
export interface WorkspaceTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly execute: (args: unknown, signal?: AbortSignal) => Promise<unknown>;
}

/** The connectors that Golem has. Token-based for now; OAuth ones arrive with Google sign-in. */
export const integrationCatalog: readonly Connector[] = [
  {
    id: "github",
    name: "GitHub",
    secretLabel: "Personal access token",
    tools: [],
  },
  { id: "linear", name: "Linear", secretLabel: "API key", tools: [] },
  {
    id: "home-assistant",
    name: "Home Assistant",
    secretLabel: "Long-lived access token",
    tools: [],
  },
];

/**
 * The outside systems the agents of a workspace use. Everything in a workspace is shared: any member adds or deletes
 * its credentials, and the agents use the newest one of each integration. Secrets never leave the server.
 */
export class Integrations {
  constructor(
    private readonly database: Database,
    private readonly secrets: Secrets,
    private readonly workspaces: Workspaces,
    private readonly catalog: readonly Connector[] = integrationCatalog
  ) {}

  list(workspaceId: string, user: User): Integration[] {
    this.workspaces.requireMember(workspaceId, user);
    const credentials = this.database
      .query(
        "SELECT c.id, c.integration, c.label, u.name AS ownerName, c.created_at AS createdAt FROM credential c JOIN user u ON u.id = c.owner_id WHERE c.workspace_id = ? ORDER BY c.created_at"
      )
      .all(workspaceId) as (CredentialSummary & { integration: string })[];
    return this.catalog.map(({ id, name, secretLabel }) => ({
      id,
      name,
      secretLabel,
      credentials: credentials
        .filter((credential) => credential.integration === id)
        .map(({ integration: _, ...credential }) => credential),
    }));
  }

  addCredential(
    workspaceId: string,
    user: User,
    integrationId: string,
    input: { label: string; secret: string }
  ): CredentialSummary {
    this.workspaces.requireMember(workspaceId, user);
    this.connector(integrationId);
    const credential = {
      id: randomUUID(),
      label: required(input.label, "Label"),
      ownerName: user.name,
      createdAt: Date.now(),
    };
    // `shared` is left from when credentials could be private.
    this.database
      .query(
        "INSERT INTO credential (id, workspace_id, integration, owner_id, label, shared, secret, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
      )
      .run(
        credential.id,
        workspaceId,
        integrationId,
        user.id,
        credential.label,
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
      .query("DELETE FROM credential WHERE id = ? AND workspace_id = ?")
      .run(credentialId, workspaceId);
    if (changes === 0) {
      throw notFound();
    }
  }

  /** The tools of every connector for the agents and routines of a workspace. */
  tools(workspaceId: string): WorkspaceTool[] {
    return this.catalog.flatMap((connector) =>
      connector.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (args: unknown, signal?: AbortSignal) =>
          tool.execute(
            args as never,
            this.secret(workspaceId, connector),
            signal
          ),
      }))
    );
  }

  /** The newest secret of the workspace for a connector. */
  private secret(workspaceId: string, connector: Connector): string {
    const row = this.database
      .query(
        "SELECT secret FROM credential WHERE workspace_id = ? AND integration = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(workspaceId, connector.id) as { secret: Uint8Array } | null;
    if (!row) {
      throw new Error(
        `${connector.name} is not connected. Someone must add a credential in Workspace settings, Integrations.`
      );
    }
    return this.secrets.decrypt(row.secret);
  }

  private connector(integrationId: string): Connector {
    const connector = this.catalog.find(
      (candidate) => candidate.id === integrationId
    );
    if (!connector) {
      throw notFound();
    }
    return connector;
  }
}

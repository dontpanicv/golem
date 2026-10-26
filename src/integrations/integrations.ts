import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
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
  /** `null`: people connect it by signing in, not with a secret. */
  readonly secretLabel: string | null;
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

/**
 * An outside system that agents use through the tools of its connector, with a secret from Workspace settings, or
 * through the tools of its MCP server, after someone signs in to it.
 */
export interface Connector {
  readonly id: string;
  readonly name: string;
  /** What agents do with it; the description of its codemode namespace. */
  readonly description: string;
  /** `null` for an MCP server, which people sign in to. */
  readonly secretLabel: string | null;
  readonly tools: readonly ConnectorTool[];
  /** The address of its MCP server, which gives the tools. */
  readonly mcp?: string;
}

/** A connector tool of one workspace, with its credential applied. */
export interface WorkspaceTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  /** The value that `execute` returns, when the tool declares it. */
  readonly outputSchema?: TSchema;
  readonly execute: (args: unknown, signal?: AbortSignal) => Promise<unknown>;
}

/** A codemode namespace of a connector's tools, which all start with `<id>_`. */
export interface ConnectorNamespace {
  readonly name: string;
  readonly prefix: string;
  readonly description: string;
}

export interface IntegrationsOptions {
  /** The address people open; MCP sign-ins come back to it. */
  readonly baseUrl: string;
  /** Called when the connector tools of a workspace change: a credential was added, connected, or deleted. */
  readonly changed?: (workspaceId: string) => void;
  readonly catalog?: readonly Connector[];
  /** Connects to an MCP server; tests pass an in-memory one. */
  readonly transport?: (url: URL, provider: OAuthClientProvider) => Transport;
}

/** What a credential of an MCP server keeps, encrypted: its OAuth client, and its tokens once someone signed in. */
interface McpGrant {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

/** A sign-in that someone started, until the MCP server's sign-in page sends them back. */
interface PendingSignIn {
  readonly provider: GrantProvider;
  readonly workspaceId: string;
  readonly user: User;
  readonly connector: Connector;
  /** The iOS app started it, so the end goes back to the app. */
  readonly app: boolean;
  readonly expiresAt: number;
}

const SIGN_IN_MS = 10 * 60 * 1000;

/** The connectors that Golem has. Token-based for now; OAuth ones arrive with Google sign-in. */
export const integrationCatalog: readonly Connector[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Code, issues, and pull requests.",
    secretLabel: "Personal access token",
    tools: [],
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues and projects.",
    secretLabel: "API key",
    tools: [],
  },
  {
    id: "home-assistant",
    name: "Home Assistant",
    description: "The lights, devices, and sensors of the home.",
    secretLabel: "Long-lived access token",
    tools: [],
  },
  {
    id: "rohlik",
    name: "Rohlík",
    description:
      "The family's grocery shop with delivery: products, the cart, orders and their history, recipes, and shopping lists. Put things in the cart; people place the order themselves.",
    secretLabel: null,
    tools: [],
    mcp: "https://mcp.rohlik.cz/mcp",
  },
];

/**
 * The outside systems the agents of a workspace use. Everything in a workspace is shared: any member adds or deletes
 * its credentials, and the agents use the newest one of each integration. Secrets never leave the server.
 */
export class Integrations {
  private readonly catalog: readonly Connector[];
  /** The sign-ins in progress, by their OAuth `state`. */
  private readonly signIns = new Map<string, PendingSignIn>();
  /** One MCP client for each credential, connected at first use. */
  private readonly clients = new Map<string, Promise<Client>>();

  constructor(
    private readonly database: Database,
    private readonly secrets: Secrets,
    private readonly workspaces: Workspaces,
    private readonly options: IntegrationsOptions
  ) {
    this.catalog = options.catalog ?? integrationCatalog;
  }

  list(workspaceId: string, user: User): Integration[] {
    this.workspaces.requireMember(workspaceId, user);
    const credentials = this.database
      .query(
        "SELECT c.id, c.integration, c.label, u.name AS ownerName, c.created_at AS createdAt FROM credential c JOIN user u ON u.id = c.owner_id WHERE c.workspace_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at"
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
    if (this.connector(integrationId).mcp) {
      throw new HttpError(400, "Connect it by signing in");
    }
    return this.insertCredential(
      workspaceId,
      user,
      integrationId,
      required(input.label, "Label"),
      required(input.secret, "Secret")
    );
  }

  /**
   * Starts a sign-in to a connector's MCP server: registers Golem with its sign-in server when needed, and returns the
   * page where the person signs in. That page sends them back to `finishConnect`.
   */
  async connect(
    workspaceId: string,
    user: User,
    integrationId: string,
    input: { app?: boolean }
  ): Promise<{ url: string }> {
    this.workspaces.requireMember(workspaceId, user);
    const connector = this.connector(integrationId);
    if (!connector.mcp) {
      throw notFound();
    }
    const now = Date.now();
    for (const [state, pending] of this.signIns) {
      if (pending.expiresAt < now) {
        this.signIns.delete(state);
      }
    }
    const state = randomUUID();
    const provider = new GrantProvider(this.redirectUrl(), {}, state);
    await auth(provider, { serverUrl: connector.mcp });
    if (!provider.authorizationUrl) {
      throw new Error(`${connector.name} gave no sign-in page`);
    }
    this.signIns.set(state, {
      provider,
      workspaceId,
      user,
      connector,
      app: input.app === true,
      expiresAt: now + SIGN_IN_MS,
    });
    return { url: provider.authorizationUrl.href };
  }

  /**
   * Ends a sign-in that the MCP server's sign-in page sent back: gets the tokens and keeps them as a credential of the
   * workspace. Without `code` the person cancelled. Each `state` works once.
   */
  async finishConnect(
    state: string,
    code: string | null
  ): Promise<{ workspaceId: string; app: boolean }> {
    const pending = this.signIns.get(state);
    this.signIns.delete(state);
    if (!pending || pending.expiresAt < Date.now()) {
      throw notFound();
    }
    const { provider, workspaceId, user, connector, app } = pending;
    if (code) {
      await auth(provider, {
        serverUrl: connector.mcp!,
        authorizationCode: code,
      });
      this.insertCredential(
        workspaceId,
        user,
        connector.id,
        connector.name,
        JSON.stringify(provider.grant)
      );
    }
    return { workspaceId, app };
  }

  private insertCredential(
    workspaceId: string,
    user: User,
    integrationId: string,
    label: string,
    secret: string
  ): CredentialSummary {
    const credential = {
      id: randomUUID(),
      label,
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
        label,
        this.secrets.encrypt(secret),
        credential.createdAt
      );
    this.options.changed?.(workspaceId);
    return credential;
  }

  deleteCredential(
    workspaceId: string,
    user: User,
    credentialId: string
  ): void {
    this.workspaces.requireMember(workspaceId, user);
    // Nothing is removed: the credential stays encrypted, and no tool reads it again.
    const { changes } = this.database
      .query(
        "UPDATE credential SET deleted_at = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL"
      )
      .run(Date.now(), credentialId, workspaceId);
    if (changes === 0) {
      throw notFound();
    }
    this.closeClient(credentialId);
    this.options.changed?.(workspaceId);
  }

  /** The tools of every connector for the agents and routines of a workspace. */
  async tools(workspaceId: string): Promise<WorkspaceTool[]> {
    const tools = await Promise.all(
      this.catalog.map((connector) =>
        connector.mcp
          ? this.mcpTools(workspaceId, connector)
          : connector.tools.map((tool) => ({
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
      )
    );
    return tools.flat();
  }

  /** The codemode namespace of each connector. */
  namespaces(): ConnectorNamespace[] {
    return this.catalog.map((connector) => ({
      name: connector.id,
      prefix: `${connector.id}_`,
      description: connector.description,
    }));
  }

  /** Closes the connections to MCP servers. */
  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(
      clients.map(async (client) => (await client).close())
    );
  }

  /**
   * The tools of a connector's MCP server, named `<id>_<tool>`, with the workspace's newest sign-in. None without a
   * sign-in, or when the server fails, so one shop that is down does not stop the agents.
   */
  private async mcpTools(
    workspaceId: string,
    connector: Connector
  ): Promise<WorkspaceTool[]> {
    const credential = this.newestCredential(workspaceId, connector);
    if (!credential) {
      return [];
    }
    try {
      const listed: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
      let cursor: string | undefined;
      do {
        const page = await this.withClient(credential, connector, (client) =>
          client.listTools(cursor ? { cursor } : undefined)
        );
        listed.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return listed.map((tool) => ({
        name: `${connector.id}_${tool.name}`,
        description: tool.description ?? "",
        parameters: tool.inputSchema as TSchema,
        ...(tool.outputSchema
          ? { outputSchema: tool.outputSchema as TSchema }
          : {}),
        execute: async (args: unknown, signal?: AbortSignal) => {
          const result = await this.withClient(
            credential,
            connector,
            (client) =>
              client.callTool(
                { name: tool.name, arguments: args as Record<string, unknown> },
                undefined,
                { signal }
              )
          );
          const text = (result.content as { type: string; text?: string }[])
            .flatMap((item) => (item.type === "text" ? [item.text ?? ""] : []))
            .join("\n");
          if (result.isError) {
            throw new Error(text || `${connector.name} failed`);
          }
          return result.structuredContent ?? text;
        },
      }));
    } catch (error) {
      console.error(`listing the tools of ${connector.name} failed`, error);
      return [];
    }
  }

  /**
   * Runs `use` with the credential's MCP client. A server that forgot the client's session answers 404 before it
   * runs anything, so the call runs once more on a new session.
   */
  private async withClient<Result>(
    credential: { id: string; grant: McpGrant },
    connector: Connector,
    use: (client: Client) => Promise<Result>
  ): Promise<Result> {
    try {
      return await use(await this.client(credential, connector));
    } catch (error) {
      if (!(error instanceof StreamableHTTPError && error.code === 404)) {
        throw error;
      }
      this.closeClient(credential.id);
      return use(await this.client(credential, connector));
    }
  }

  private client(
    credential: { id: string; grant: McpGrant },
    connector: Connector
  ): Promise<Client> {
    let client = this.clients.get(credential.id);
    if (!client) {
      // The SDK refreshes the tokens; each new grant replaces the stored one.
      const provider = new GrantProvider(
        this.redirectUrl(),
        credential.grant,
        undefined,
        (grant) =>
          this.database
            .query("UPDATE credential SET secret = ? WHERE id = ?")
            .run(this.secrets.encrypt(JSON.stringify(grant)), credential.id)
      );
      const url = new URL(connector.mcp!);
      const transport =
        this.options.transport?.(url, provider) ??
        new StreamableHTTPClientTransport(url, { authProvider: provider });
      const connecting = new Client({ name: "Golem", version: "1" });
      client = connecting.connect(transport).then(() => connecting);
      client.catch(() => this.clients.delete(credential.id));
      this.clients.set(credential.id, client);
    }
    return client;
  }

  private closeClient(credentialId: string): void {
    const client = this.clients.get(credentialId);
    this.clients.delete(credentialId);
    client?.then((connected) => connected.close()).catch(() => undefined);
  }

  private newestCredential(
    workspaceId: string,
    connector: Connector
  ): { id: string; grant: McpGrant } | undefined {
    const row = this.database
      .query(
        "SELECT id, secret FROM credential WHERE workspace_id = ? AND integration = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"
      )
      .get(workspaceId, connector.id) as {
      id: string;
      secret: Uint8Array;
    } | null;
    return row
      ? { id: row.id, grant: JSON.parse(this.secrets.decrypt(row.secret)) }
      : undefined;
  }

  private redirectUrl(): string {
    return new URL("/api/v1/integrations/callback", this.options.baseUrl).href;
  }

  /** The newest secret of the workspace for a connector. */
  private secret(workspaceId: string, connector: Connector): string {
    const row = this.database
      .query(
        "SELECT secret FROM credential WHERE workspace_id = ? AND integration = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"
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

/** The OAuth state of one grant, as the MCP SDK reads and writes it: the registered client, the tokens, and PKCE. */
class GrantProvider implements OAuthClientProvider {
  /** The sign-in page, once the SDK wants the person to sign in. */
  authorizationUrl: URL | undefined;
  private verifier = "";

  constructor(
    readonly redirectUrl: string,
    readonly grant: McpGrant,
    private readonly signInState?: string,
    private readonly saved: (grant: McpGrant) => void = () => undefined
  ) {}

  get clientMetadata() {
    return {
      client_name: "Golem",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.signInState ?? randomUUID();
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.grant.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.grant.client = client;
  }

  tokens(): OAuthTokens | undefined {
    return this.grant.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.grant.tokens = tokens;
    this.saved(this.grant);
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

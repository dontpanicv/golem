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

/**
 * Where a credential belongs, which says whose turns use it: a workspace id, for the turns of every member there, or
 * `null`, for a person's own, for their turns in each of their workspaces.
 */
export type Place = string | null;

/** The turn a tool call is part of: the person it is for, whose own credentials come first. */
export interface Turn {
  readonly userId: string | null;
  readonly signal?: AbortSignal;
}

/** A connector tool of one workspace; each call uses the credential of the turn it is part of. */
export interface WorkspaceTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  /** The value that `execute` returns, when the tool declares it. */
  readonly outputSchema?: TSchema;
  readonly execute: (args: unknown, turn: Turn) => Promise<unknown>;
}

/** A codemode namespace of a connector's tools, which all start with `<id>_`. */
export interface ConnectorNamespace {
  readonly name: string;
  readonly prefix: string;
  readonly description: string;
}

export interface IntegrationsOptions {
  /** Called when the connector tools of a workspace may change: a credential there or of a member changed. */
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
  readonly place: Place;
  readonly user: User;
  readonly connector: Connector;
  readonly expiresAt: number;
}

const SIGN_IN_MS = 10 * 60 * 1000;
/**
 * Where an MCP server's sign-in page sends people. Rohlík registers only loopback addresses (and clients it knows) for
 * clients that register themselves, so the browser ends on an error page at this address, and the person pastes the
 * address into Golem, which reads the sign-in code from it.
 */
const SIGN_IN_ADDRESS = "http://localhost/golem-sign-in";

/** The connectors that Golem has: ones with a secret, and MCP servers that people sign in to. */
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
 * The outside systems that agents use. A person connects an integration in a workspace, for every member's turns there,
 * or for themselves, for their own turns in each of their workspaces; one connector serves both. A turn uses the
 * newest credential of the person it is for, else the workspace's newest. Any member adds or deletes a workspace's
 * credentials, and only their owner a person's own. Secrets never leave the server.
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

  list(place: Place, user: User): Integration[] {
    this.requireAccess(place, user);
    const credentials = this.database
      .query(
        "SELECT c.id, c.integration, c.label, u.name AS ownerName, c.created_at AS createdAt FROM credential c JOIN user u ON u.id = c.owner_id WHERE (c.workspace_id = ?1 OR (?1 IS NULL AND c.workspace_id IS NULL AND c.owner_id = ?2)) AND c.deleted_at IS NULL ORDER BY c.created_at"
      )
      .all(place, user.id) as (CredentialSummary & { integration: string })[];
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
    place: Place,
    user: User,
    integrationId: string,
    input: { label: string; secret: string }
  ): CredentialSummary {
    this.requireAccess(place, user);
    if (this.connector(integrationId).mcp) {
      throw new HttpError(400, "Connect it by signing in");
    }
    return this.insertCredential(
      place,
      user,
      integrationId,
      required(input.label, "Label"),
      required(input.secret, "Secret")
    );
  }

  /**
   * Starts a sign-in to a connector's MCP server: registers Golem with its sign-in server, and returns the page where
   * the person signs in. That page ends at an address that the person gives to `finishConnect`.
   */
  async connect(
    place: Place,
    user: User,
    integrationId: string
  ): Promise<{ url: string }> {
    this.requireAccess(place, user);
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
    const provider = new GrantProvider({}, state);
    await signIn(connector, provider);
    if (!provider.authorizationUrl) {
      throw new HttpError(502, `${connector.name} gave no sign-in page`);
    }
    this.signIns.set(state, {
      provider,
      place,
      user,
      connector,
      expiresAt: now + SIGN_IN_MS,
    });
    return { url: provider.authorizationUrl.href };
  }

  /**
   * Ends the person's own sign-in with the address where its page ended: gets the tokens and keeps them as a credential
   * of the place where the sign-in started. Each sign-in works once.
   */
  async finishConnect(
    place: Place,
    user: User,
    integrationId: string,
    address: string
  ): Promise<CredentialSummary> {
    this.requireAccess(place, user);
    const query = URL.parse(required(address, "Address"))?.searchParams;
    const state = query?.get("state") ?? "";
    const pending = this.signIns.get(state);
    if (
      !pending ||
      pending.place !== place ||
      pending.user.id !== user.id ||
      pending.connector.id !== integrationId ||
      pending.expiresAt < Date.now()
    ) {
      throw new HttpError(400, "This is not the address of your sign-in");
    }
    this.signIns.delete(state);
    const code = query?.get("code");
    if (!code) {
      throw new HttpError(400, "The sign-in did not finish");
    }
    const { provider, connector } = pending;
    await signIn(connector, provider, code);
    return this.insertCredential(
      place,
      user,
      connector.id,
      connector.name,
      JSON.stringify(provider.grant)
    );
  }

  private insertCredential(
    place: Place,
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
        place,
        integrationId,
        user.id,
        label,
        this.secrets.encrypt(secret),
        credential.createdAt
      );
    this.changedFor(place, user);
    return credential;
  }

  deleteCredential(place: Place, user: User, credentialId: string): void {
    this.requireAccess(place, user);
    // Nothing is removed: the credential stays encrypted, and no tool reads it again.
    const { changes } = this.database
      .query(
        "UPDATE credential SET deleted_at = ?1 WHERE id = ?2 AND (workspace_id = ?3 OR (?3 IS NULL AND workspace_id IS NULL AND owner_id = ?4)) AND deleted_at IS NULL"
      )
      .run(Date.now(), credentialId, place, user.id);
    if (changes === 0) {
      throw notFound();
    }
    this.closeClient(credentialId);
    this.changedFor(place, user);
  }

  /**
   * The tools of every connector for the agents and routines of a workspace: of each connector that the workspace or
   * one of its members connected. Each call uses the credential of its turn's person, else the workspace's.
   */
  async tools(workspaceId: string): Promise<WorkspaceTool[]> {
    const tools = await Promise.all(
      this.catalog.map((connector) =>
        connector.mcp
          ? this.mcpTools(workspaceId, connector)
          : connector.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              execute: async (args: unknown, turn: Turn) =>
                tool.execute(
                  args as never,
                  this.credentialFor(workspaceId, connector, turn.userId)
                    .secret,
                  turn.signal
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
   * The tools of a connector's MCP server, named `<id>_<tool>`, as a sign-in of the workspace or of a member lists them.
   * None without a sign-in, or when the server fails, so one shop that is down does not stop the agents.
   */
  private async mcpTools(
    workspaceId: string,
    connector: Connector
  ): Promise<WorkspaceTool[]> {
    const lister = this.newestCredential(
      workspaceId,
      connector,
      this.memberIds(workspaceId)
    );
    if (!lister) {
      return [];
    }
    try {
      const listed: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
      let cursor: string | undefined;
      do {
        const page = await this.withClient(lister, connector, (client) =>
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
        execute: async (args: unknown, turn: Turn) => {
          const { id, secret } = this.credentialFor(
            workspaceId,
            connector,
            turn.userId
          );
          const result = await this.withClient(
            { id, grant: JSON.parse(secret) },
            connector,
            (client) =>
              client.callTool(
                { name: tool.name, arguments: args as Record<string, unknown> },
                undefined,
                { signal: turn.signal }
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
      const provider = new GrantProvider(credential.grant, undefined, (grant) =>
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

  /** The credential that a turn of `userId` in a workspace uses for a connector. */
  private credentialFor(
    workspaceId: string,
    connector: Connector,
    userId: string | null
  ): { id: string; secret: string } {
    const people =
      userId && this.memberIds(workspaceId).includes(userId) ? [userId] : [];
    const row = this.newestRow(workspaceId, connector, people);
    if (!row) {
      throw new Error(
        `${connector.name} is not connected. Connect it in your own Settings, or for everyone in Workspace settings.`
      );
    }
    return { id: row.id, secret: this.secrets.decrypt(row.secret) };
  }

  /** The newest MCP grant of a workspace or of one of `people`, theirs first. */
  private newestCredential(
    workspaceId: string,
    connector: Connector,
    people: readonly string[]
  ): { id: string; grant: McpGrant } | undefined {
    const row = this.newestRow(workspaceId, connector, people);
    return row
      ? { id: row.id, grant: JSON.parse(this.secrets.decrypt(row.secret)) }
      : undefined;
  }

  /** The newest credential of a connector that is the own of one of `people`, else the workspace's newest. */
  private newestRow(
    workspaceId: string,
    connector: Connector,
    people: readonly string[]
  ): { id: string; secret: Uint8Array } | null {
    return this.database
      .query(
        `SELECT id, secret FROM credential WHERE integration = ? AND deleted_at IS NULL AND (workspace_id = ? OR (workspace_id IS NULL AND owner_id IN (${people.map(() => "?").join(", ")}))) ORDER BY workspace_id IS NOT NULL, created_at DESC LIMIT 1`
      )
      .get(connector.id, workspaceId, ...people) as {
      id: string;
      secret: Uint8Array;
    } | null;
  }

  private memberIds(workspaceId: string): string[] {
    return this.workspaces
      .members(workspaceId, this.workspaces.agentMember(workspaceId))
      .map((member) => member.userId);
  }

  /** A workspace's credentials are for its members; a person's own only for them. */
  private requireAccess(place: Place, user: User): void {
    if (place !== null) {
      this.workspaces.requireMember(place, user);
    }
  }

  /** Tells the workspaces whose tools a credential of `place` may change: the person's own reach all of theirs. */
  private changedFor(place: Place, user: User): void {
    const workspaceIds =
      place === null
        ? this.workspaces.list(user).map((workspace) => workspace.id)
        : [place];
    for (const workspaceId of workspaceIds) {
      this.options.changed?.(workspaceId);
    }
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

/** Runs the MCP SDK's sign-in step; a refusal of the sign-in server reaches the person with its reason. */
async function signIn(
  connector: Connector,
  provider: GrantProvider,
  authorizationCode?: string
): Promise<void> {
  try {
    await auth(provider, {
      serverUrl: connector.mcp!,
      ...(authorizationCode ? { authorizationCode } : {}),
    });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: HttpError takes the cause as its third argument.
    throw new HttpError(
      502,
      `${connector.name} refused the sign-in: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

/** The OAuth state of one grant, as the MCP SDK reads and writes it: the registered client, the tokens, and PKCE. */
class GrantProvider implements OAuthClientProvider {
  readonly redirectUrl = SIGN_IN_ADDRESS;
  /** The sign-in page, once the SDK wants the person to sign in. */
  authorizationUrl: URL | undefined;
  private verifier = "";

  constructor(
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

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
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
import type { OAuthClient } from "../platform/config.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
import type { Secrets } from "../platform/secrets.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";
import { integrationCatalog } from "./catalog.ts";

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
  /** How people connect it: with a secret, by signing in on its page, or by linking their phone number. */
  readonly connect: "secret" | "sign-in" | "phone";
  /** The name of the secret, for `connect: "secret"`. */
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
 * An outside system that agents use: through the tools of its connector, with a secret from Settings or with a device
 * linked to a person's number, or through the tools of its MCP servers, after someone signs in to them.
 */
export interface Connector {
  readonly id: string;
  readonly name: string;
  /** What agents do with it; the description of its codemode namespace. */
  readonly description: string;
  /** `null` for MCP servers, which people sign in to, and for a device. */
  readonly secretLabel: string | null;
  readonly tools: readonly ConnectorTool[];
  /** The addresses of its MCP servers, which give the tools; one sign-in serves them all. */
  readonly mcp?: readonly string[];
  /**
   * It signs in with Golem's own OAuth client, from `[integrations.<id>]` in golem.toml, because its sign-in server does
   * not register clients. Golem offers it only with that client.
   */
  readonly registered?: boolean;
  /** The OAuth scopes that its sign-in asks for; else the ones that its server gives. */
  readonly scope?: string;
  /** More parameters of its sign-in page, such as Google's `access_type=offline` for a refresh token. */
  readonly authorizationParameters?: Readonly<Record<string, string>>;
  /** The tools of its MCP servers that agents never get, such as sending, because agents only draft. */
  readonly hiddenTools?: readonly string[];
  /** The device that Golem links to a person's number, such as WhatsApp's; its tools get the device's store. */
  readonly device?: Device;
}

/** A device that Golem links to a person's account, such as a WhatsApp number, and keeps in a store directory. */
export interface Device {
  /** Gives the code that the person enters on their phone, and `linked`, which settles when they did. */
  readonly link: (
    store: string,
    phone: string
  ) => Promise<{ code: string; linked: Promise<void> }>;
  /** Keeps a linked store current while Golem runs. */
  readonly keep: (store: string) => void;
  /** Ends the link and stops keeping the store. */
  readonly unlink: (store: string) => Promise<void>;
  readonly close: () => Promise<void>;
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
  /** Where the devices keep their stores, one folder for each credential. */
  readonly directory: string;
  /** Golem's own OAuth clients, by integration id, for the integrations that need one. */
  readonly clients?: Readonly<Record<string, OAuthClient>>;
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

/** A sign-in that someone started: on the MCP server's page, or by entering a device's code on their phone. */
interface PendingSignIn {
  readonly provider?: GrantProvider;
  readonly device?: {
    readonly credentialId: string;
    readonly phone: string;
    readonly linked: Promise<void>;
  };
  readonly place: Place;
  readonly user: User;
  readonly connector: Connector;
  readonly expiresAt: number;
}

const SIGN_IN_MS = 10 * 60 * 1000;
/** How long finishing a device's link waits for the person to enter its code. */
const LINK_WAIT_MS = 60 * 1000;
/**
 * Where an MCP server's sign-in page sends people. Rohlík registers only loopback addresses for clients that register
 * themselves, and Slack only https ones, so the browser ends on an error page at this address, and the person pastes
 * the address into Golem, which reads the sign-in code from it.
 */
const SIGN_IN_ADDRESS = "https://localhost/golem-sign-in";

/**
 * The outside systems that agents use. A person connects an integration in a workspace, for every member's turns there,
 * or for themselves, for their own turns in each of their workspaces; one connector serves both. Each credential is an
 * account, such as a Google address: a turn uses the account that a tool call names, else the newest of the person it
 * is for, else the workspace's newest. Any member adds or deletes a workspace's credentials, and only their owner a
 * person's own. Secrets never leave the server.
 */
export class Integrations {
  private readonly catalog: readonly Connector[];
  /** The sign-ins in progress, by their OAuth `state`, or by the credential id of a device's link. */
  private readonly signIns = new Map<string, PendingSignIn>();
  /** One MCP client for each credential and server, by `<credential id> <server>`, connected at first use. */
  private readonly clients = new Map<string, Promise<Client>>();

  constructor(
    private readonly database: Database,
    private readonly secrets: Secrets,
    private readonly workspaces: Workspaces,
    private readonly options: IntegrationsOptions
  ) {
    this.catalog = (options.catalog ?? integrationCatalog()).filter(
      (connector) => !connector.registered || options.clients?.[connector.id]
    );
    for (const connector of this.catalog) {
      if (connector.device) {
        const linked = this.database
          .query(
            "SELECT id FROM credential WHERE integration = ? AND deleted_at IS NULL"
          )
          .all(connector.id) as { id: string }[];
        for (const { id } of linked) {
          connector.device.keep(this.store(id));
        }
      }
    }
  }

  list(place: Place, user: User): Integration[] {
    this.requireAccess(place, user);
    const credentials = this.database
      .query(
        "SELECT c.id, c.integration, c.label, u.name AS ownerName, c.created_at AS createdAt FROM credential c JOIN user u ON u.id = c.owner_id WHERE (c.workspace_id = ?1 OR (?1 IS NULL AND c.workspace_id IS NULL AND c.owner_id = ?2)) AND c.deleted_at IS NULL ORDER BY c.created_at"
      )
      .all(place, user.id) as (CredentialSummary & { integration: string })[];
    return this.catalog.map((connector) => ({
      id: connector.id,
      name: connector.name,
      connect: connectionOf(connector),
      secretLabel: connector.secretLabel,
      credentials: credentials
        .filter((credential) => credential.integration === connector.id)
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
    const connector = this.connector(integrationId);
    if (connector.mcp || connector.device) {
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
   * Starts a sign-in. For MCP servers: registers Golem with their sign-in server unless Golem has its own client, and
   * returns the page where the person signs in, which ends at an address that the person gives to `finishConnect`. For
   * a device: returns the code that the person enters on the phone of `phone`.
   */
  async connect(
    place: Place,
    user: User,
    integrationId: string,
    phone?: string
  ): Promise<{ url: string } | { code: string }> {
    this.requireAccess(place, user);
    const connector = this.connector(integrationId);
    const now = Date.now();
    for (const [state, pending] of this.signIns) {
      if (pending.expiresAt < now) {
        this.signIns.delete(state);
        if (pending.device) {
          this.unlink(pending.connector, pending.device.credentialId);
        }
      }
    }
    if (connector.device) {
      const credentialId = randomUUID();
      const number = required(phone, "Phone number");
      const { code, linked } = await connector.device.link(
        this.store(credentialId),
        number
      );
      this.signIns.set(credentialId, {
        device: { credentialId, phone: number, linked },
        place,
        user,
        connector,
        expiresAt: now + SIGN_IN_MS,
      });
      return { code };
    }
    if (!connector.mcp) {
      throw notFound();
    }
    const state = randomUUID();
    const client = this.options.clients?.[connector.id];
    const provider = new GrantProvider(
      client
        ? {
            client: {
              client_id: client.clientId,
              client_secret: client.clientSecret,
            },
          }
        : {},
      connector,
      state
    );
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
   * Ends the person's own sign-in of the place where it started, and keeps it as a credential. An MCP sign-in ends with
   * the address where its page ended, and works once; a device's when the person entered its code.
   */
  async finishConnect(
    place: Place,
    user: User,
    integrationId: string,
    address?: string
  ): Promise<CredentialSummary> {
    this.requireAccess(place, user);
    if (this.connector(integrationId).device) {
      return this.finishLink(place, user, integrationId);
    }
    const query = URL.parse(required(address, "Address"))?.searchParams;
    const state = query?.get("state") ?? "";
    const pending = this.signIns.get(state);
    if (
      !(pending?.provider && this.isOwn(pending, place, user, integrationId))
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
      emailOf(provider.grant.tokens?.id_token) ?? connector.name,
      JSON.stringify(provider.grant)
    );
  }

  /** Waits a while for the person's newest link of a device in this place, and keeps it as a credential. */
  private async finishLink(
    place: Place,
    user: User,
    integrationId: string
  ): Promise<CredentialSummary> {
    const pending = [...this.signIns.values()]
      .filter((candidate) => this.isOwn(candidate, place, user, integrationId))
      .at(-1);
    if (!pending?.device) {
      throw new HttpError(400, "Start linking again");
    }
    const { credentialId, phone, linked } = pending.device;
    let waiting: Timer | undefined;
    try {
      await Promise.race([
        linked,
        new Promise((_, reject) => {
          waiting = setTimeout(reject, LINK_WAIT_MS);
        }),
      ]);
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: HttpError takes the cause as its third argument.
      throw new HttpError(
        400,
        `${pending.connector.name} did not link. Enter the code on your phone, then try again.`,
        { cause: error }
      );
    } finally {
      clearTimeout(waiting);
    }
    this.signIns.delete(credentialId);
    return this.insertCredential(
      place,
      user,
      integrationId,
      phone,
      phone,
      credentialId
    );
  }

  private isOwn(
    pending: PendingSignIn,
    place: Place,
    user: User,
    integrationId: string
  ): boolean {
    return (
      pending.place === place &&
      pending.user.id === user.id &&
      pending.connector.id === integrationId &&
      pending.expiresAt >= Date.now()
    );
  }

  private insertCredential(
    place: Place,
    user: User,
    integrationId: string,
    label: string,
    secret: string,
    id: string = randomUUID()
  ): CredentialSummary {
    const credential = {
      id,
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
    const row = this.database
      .query(
        "SELECT integration FROM credential WHERE id = ?1 AND (workspace_id = ?2 OR (?2 IS NULL AND workspace_id IS NULL AND owner_id = ?3)) AND deleted_at IS NULL"
      )
      .get(credentialId, place, user.id) as { integration: string } | null;
    if (!row) {
      throw notFound();
    }
    // Nothing is removed: the credential stays encrypted, and no tool reads it again.
    this.database
      .query("UPDATE credential SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), credentialId);
    this.closeClient(credentialId);
    const connector = this.catalog.find(({ id }) => id === row.integration);
    if (connector?.device) {
      this.unlink(connector, credentialId);
    }
    this.changedFor(place, user);
  }

  /**
   * The tools of every connector for the agents and routines of a workspace: of each connector that the workspace or
   * one of its members connected, with `<id>_accounts`, which lists the accounts that a turn can name.
   */
  async tools(workspaceId: string): Promise<WorkspaceTool[]> {
    const tools = await Promise.all(
      this.catalog.map(async (connector) => {
        const own: AccountTool[] = connector.mcp
          ? await this.mcpTools(workspaceId, connector)
          : connector.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              call: (args, credential, signal) =>
                tool.execute(
                  args as never,
                  connector.device
                    ? this.store(credential.id)
                    : credential.secret,
                  signal
                ),
            }));
        if (own.length === 0) {
          return [];
        }
        return [
          ...own.map((tool) =>
            this.workspaceTool(workspaceId, connector, tool)
          ),
          this.accountsTool(workspaceId, connector),
        ];
      })
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

  /** Closes the connections to MCP servers, and stops keeping the devices' stores. */
  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled([
      ...clients.map(async (client) => (await client).close()),
      ...this.catalog.map((connector) => connector.device?.close()),
    ]);
  }

  /** A connector's tool whose calls use the account they name, else the turn's newest; see `credentialFor`. */
  private workspaceTool(
    workspaceId: string,
    connector: Connector,
    tool: AccountTool
  ): WorkspaceTool {
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        ...tool.parameters,
        properties: {
          ...(tool.parameters as { properties?: object }).properties,
          account: Type.String({
            description: `The ${connector.name} account, from ${connector.id}_accounts; the first one when not given.`,
          }),
        },
      },
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      execute: async (args, turn) => {
        const { account, ...rest } = args as { account?: string };
        return tool.call(
          rest,
          this.credentialFor(workspaceId, connector, turn.userId, account),
          turn.signal
        );
      },
    };
  }

  private accountsTool(
    workspaceId: string,
    connector: Connector
  ): WorkspaceTool {
    return {
      name: `${connector.id}_accounts`,
      description: `The ${connector.name} accounts that the other ${connector.id}_ tools can use for this person, by \`account\`: their own first, newest first, then the workspace's.`,
      parameters: Type.Object({}),
      execute: async (_args, turn) =>
        this.credentialRows(
          workspaceId,
          connector,
          this.turnPeople(workspaceId, turn.userId)
        ).map((row) => ({
          account: row.label,
          of: row.workspace_id ? "workspace" : "own",
        })),
    };
  }

  /**
   * The tools of a connector's MCP servers, named `<id>_<tool>`, as the workspace's sign-in lists them, else a member's
   * own; the list has only names and schemas, and no tool call uses that sign-in for another person. None of a server
   * without a sign-in, or when it fails, so one shop that is down does not stop the agents.
   */
  private async mcpTools(
    workspaceId: string,
    connector: Connector
  ): Promise<AccountTool[]> {
    const rows = this.credentialRows(
      workspaceId,
      connector,
      this.memberIds(workspaceId)
    );
    const row = rows.find((candidate) => candidate.workspace_id) ?? rows[0];
    if (!row) {
      return [];
    }
    const lister = { id: row.id, secret: this.secrets.decrypt(row.secret) };
    const prefix = `${connector.id}_`;
    const servers = await Promise.all(
      connector.mcp!.map(async (server) => {
        try {
          const listed: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
          let cursor: string | undefined;
          do {
            const page = await this.withClient(
              lister,
              connector,
              server,
              (client) => client.listTools(cursor ? { cursor } : undefined)
            );
            listed.push(...page.tools);
            cursor = page.nextCursor;
          } while (cursor);
          return listed
            .filter((tool) => !connector.hiddenTools?.includes(tool.name))
            .map(
              (tool): AccountTool => ({
                // Slack's tools already start with `slack_`.
                name: tool.name.startsWith(prefix)
                  ? tool.name
                  : `${prefix}${tool.name}`,
                description: tool.description ?? "",
                parameters: tool.inputSchema as TSchema,
                ...(tool.outputSchema
                  ? { outputSchema: tool.outputSchema as TSchema }
                  : {}),
                call: async (args, credential, signal) => {
                  const result = await this.withClient(
                    credential,
                    connector,
                    server,
                    (client) =>
                      client.callTool(
                        {
                          name: tool.name,
                          arguments: args as Record<string, unknown>,
                        },
                        undefined,
                        { signal }
                      )
                  );
                  const text = (
                    result.content as { type: string; text?: string }[]
                  )
                    .flatMap((item) =>
                      item.type === "text" ? [item.text ?? ""] : []
                    )
                    .join("\n");
                  if (result.isError) {
                    throw new Error(text || `${connector.name} failed`);
                  }
                  return result.structuredContent ?? text;
                },
              })
            );
        } catch (error) {
          console.error(`listing the tools of ${server} failed`, error);
          return [];
        }
      })
    );
    return servers.flat();
  }

  /**
   * Runs `use` with the credential's MCP client of a server. A server that forgot the client's session answers 404
   * before it runs anything, so the call runs once more on a new session.
   */
  private async withClient<Result>(
    credential: Credential,
    connector: Connector,
    server: string,
    use: (client: Client) => Promise<Result>
  ): Promise<Result> {
    try {
      return await use(await this.client(credential, connector, server));
    } catch (error) {
      if (!(error instanceof StreamableHTTPError && error.code === 404)) {
        throw error;
      }
      this.closeClient(credential.id, server);
      return use(await this.client(credential, connector, server));
    }
  }

  private client(
    credential: Credential,
    connector: Connector,
    server: string
  ): Promise<Client> {
    const key = `${credential.id} ${server}`;
    let client = this.clients.get(key);
    if (!client) {
      // The SDK refreshes the tokens; each new grant replaces the stored one.
      const provider = new GrantProvider(
        JSON.parse(credential.secret),
        connector,
        undefined,
        (grant) =>
          this.database
            .query("UPDATE credential SET secret = ? WHERE id = ?")
            .run(this.secrets.encrypt(JSON.stringify(grant)), credential.id)
      );
      const url = new URL(server);
      const transport =
        this.options.transport?.(url, provider) ??
        new StreamableHTTPClientTransport(url, { authProvider: provider });
      const connecting = new Client({ name: "Golem", version: "1" });
      client = connecting.connect(transport).then(() => connecting);
      client.catch(() => this.clients.delete(key));
      this.clients.set(key, client);
    }
    return client;
  }

  /** Closes the credential's MCP clients: of one server, or of all. */
  private closeClient(credentialId: string, server?: string): void {
    for (const [key, client] of this.clients) {
      if (
        server
          ? key === `${credentialId} ${server}`
          : key.startsWith(`${credentialId} `)
      ) {
        this.clients.delete(key);
        client.then((connected) => connected.close()).catch(() => undefined);
      }
    }
  }

  /** Ends a device's link, and moves its store aside, as deleted files are. */
  private unlink(connector: Connector, credentialId: string): void {
    const store = this.store(credentialId);
    connector
      .device!.unlink(store)
      .then(() => {
        const deleted = join(this.options.directory, "deleted");
        mkdirSync(deleted, { recursive: true });
        renameSync(store, join(deleted, credentialId));
      })
      .catch((error: unknown) =>
        console.error(`unlinking ${connector.name} failed`, error)
      );
  }

  private store(credentialId: string): string {
    return join(this.options.directory, credentialId);
  }

  /**
   * The credential that a turn of `userId` in a workspace uses for a connector: the one named `account`, else the
   * person's newest, else the workspace's newest.
   */
  private credentialFor(
    workspaceId: string,
    connector: Connector,
    userId: string | null,
    account: string | undefined
  ): Credential {
    const rows = this.credentialRows(
      workspaceId,
      connector,
      this.turnPeople(workspaceId, userId)
    );
    if (rows.length === 0) {
      throw new Error(
        `${connector.name} is not connected. Connect it in your own Settings, or for everyone in Workspace settings.`
      );
    }
    const row = account
      ? rows.find(
          (candidate) => candidate.label.toLowerCase() === account.toLowerCase()
        )
      : rows[0];
    if (!row) {
      throw new Error(
        `${connector.name} has no account ${account}; it has ${rows.map((candidate) => candidate.label).join(", ")}.`
      );
    }
    return { id: row.id, secret: this.secrets.decrypt(row.secret) };
  }

  /** The credentials of a connector that are the own of one of `people`, newest first, then the workspace's. */
  private credentialRows(
    workspaceId: string,
    connector: Connector,
    people: readonly string[]
  ): CredentialRow[] {
    return this.database
      .query(
        `SELECT id, label, workspace_id, secret FROM credential WHERE integration = ? AND deleted_at IS NULL AND (workspace_id = ? OR (workspace_id IS NULL AND owner_id IN (${people.map(() => "?").join(", ")}))) ORDER BY workspace_id IS NOT NULL, created_at DESC, rowid DESC`
      )
      .all(connector.id, workspaceId, ...people) as CredentialRow[];
  }

  /** The person of a turn, when they are a member of its workspace. */
  private turnPeople(workspaceId: string, userId: string | null): string[] {
    return userId && this.memberIds(workspaceId).includes(userId)
      ? [userId]
      : [];
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

/** A credential as a tool call uses it: its id and its decrypted secret. */
interface Credential {
  readonly id: string;
  readonly secret: string;
}

interface CredentialRow {
  readonly id: string;
  readonly label: string;
  readonly workspace_id: string | null;
  readonly secret: Uint8Array;
}

/** A connector's tool before it gets its `account`: it runs with the credential that the call chose. */
interface AccountTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly outputSchema?: TSchema;
  readonly call: (
    args: unknown,
    credential: Credential,
    signal: AbortSignal | undefined
  ) => Promise<unknown>;
}

function connectionOf(connector: Connector): Integration["connect"] {
  if (connector.device) {
    return "phone";
  }
  return connector.mcp ? "sign-in" : "secret";
}

/** The email address in an OpenID token, which names the account of a sign-in, such as a Google one. */
function emailOf(idToken: string | undefined): string | undefined {
  try {
    const claims = JSON.parse(
      Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString()
    ) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
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
      serverUrl: connector.mcp![0]!,
      ...(connector.scope ? { scope: connector.scope } : {}),
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

/** The OAuth state of one grant, as the MCP SDK reads and writes it: the client, the tokens, and PKCE. */
class GrantProvider implements OAuthClientProvider {
  readonly redirectUrl = SIGN_IN_ADDRESS;
  /** The sign-in page, once the SDK wants the person to sign in. */
  authorizationUrl: URL | undefined;
  /** Leaves out the token's resource: one token of Google serves its three servers. */
  readonly validateResourceURL?: () => Promise<undefined>;
  private verifier = "";

  constructor(
    readonly grant: McpGrant,
    private readonly connector: Connector,
    private readonly signInState?: string,
    private readonly saved: (grant: McpGrant) => void = () => undefined
  ) {
    if (connector.mcp!.length > 1) {
      this.validateResourceURL = async () => undefined;
    }
  }

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
    for (const [name, value] of Object.entries(
      this.connector.authorizationParameters ?? {}
    )) {
      url.searchParams.set(name, value);
    }
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

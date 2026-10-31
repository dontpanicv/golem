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
import { SIGN_IN_ADDRESS } from "./sign-in.ts";

export interface CredentialSummary {
  readonly createdAt: number;
  readonly id: string;
  readonly label: string;
  /** The person who connected it, whose account it is; only they share, make private, or delete it. */
  readonly ownerId: string;
  readonly ownerName: string;
  /** Whether the turns of every member use it; else only the turns of its owner. */
  readonly shared: boolean;
}
export interface Integration {
  readonly credentials: readonly CredentialSummary[];
  readonly id: string;
  readonly name: string;
  /** How people connect it: with a secret, by signing in on its page, or by linking their phone number. */
  readonly connect: "secret" | "sign-in" | "phone";
  /** The name of the secret, for `connect: "secret"`. */
  readonly secretLabel: string | null;
  /** Whether the person names a credential; else Golem names it from the secret, such as by its Slack workspace. */
  readonly labeled: boolean;
  /** Whether a secret also needs the address of the person's own server, such as their Home Assistant's. */
  readonly address: boolean;
  /** The name of the account that a secret also needs, such as `Email`, which names the credential; else `null`. */
  readonly username: string | null;
  /** The steps that set it up, in Markdown; empty when Connect is all. */
  readonly guide: readonly string[];
  /**
   * Golem's own OAuth client, for an integration whose sign-in server does not register clients: its ID once the
   * server's owner set it, and whether this person may set it. `null` for the other integrations.
   */
  readonly client: {
    readonly clientId: string | null;
    readonly changeable: boolean;
  } | null;
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
    signal: AbortSignal | undefined,
    file?: FileOf,
    allowed?: string
  ): Promise<unknown>;
  /**
   * What a person allows before each call, such as `Send on Slack to #family: Dinner at 7`; `execute` then gets it as
   * `allowed`. A tool with it acts as the person, such as one that sends; it asks every time.
   */
  // biome-ignore lint/style/useConsistentMethodSignatures: a method keeps a tool with typed arguments a ConnectorTool.
  approval?(
    args: Static<Parameters>,
    secret: string,
    signal: AbortSignal | undefined,
    file?: FileOf
  ): string | Promise<string>;
}

/** Finds a file of the workspace by its id, such as one to attach; it throws when there is none. */
export type FileOf = (
  fileId: string
) => Promise<{ readonly path: string; readonly name: string }>;

/**
 * An outside system that agents use: through the tools of its connector, with a secret from Settings, with a device
 * linked to a person's number, or with the access token of a sign-in, or through the tools of its MCP servers, after
 * someone signs in to them.
 */
export interface Connector {
  readonly id: string;
  readonly name: string;
  /** What agents do with it; the description of its codemode namespace. */
  readonly description: string;
  /** `null` for a sign-in, and for a device. */
  readonly secretLabel: string | null;
  /**
   * Its secret also needs the address of the person's own server. The tools then get the secret as JSON
   * `{ address, secret }`.
   */
  readonly address?: boolean;
  /**
   * Its secret also needs the person's account, such as the email of their Salus account, under this name; the account
   * names the credential, and `secretFrom`, else the tools, get the secret as JSON `{ username, secret }`.
   */
  readonly username?: string;
  /** The steps that set it up, in Markdown, which Settings shows. */
  readonly guide?: readonly string[];
  readonly tools: readonly ConnectorTool[];
  /** The addresses of its MCP servers, which give the tools; one sign-in serves them all. */
  readonly mcp?: readonly string[];
  /**
   * The OAuth server that people sign in to, for a connector whose own tools call its API, such as Google's; the tools
   * then get a fresh access token instead of a secret.
   */
  readonly oauth?: string;
  /** The sign-in page and token endpoint of an `oauth` server that does not publish them, such as Netatmo's. */
  readonly oauthEndpoints?: {
    readonly authorization: string;
    readonly token: string;
  };
  /**
   * It signs in with Golem's own OAuth client, which the server's owner sets in Settings, because its sign-in server
   * does not register clients. Only the owner sees it until then.
   */
  readonly registered?: boolean;
  /** The OAuth scopes that its sign-in asks for; else the ones that its server gives. */
  readonly scope?: string;
  /** More parameters of its sign-in page, such as Google's `access_type=offline` for a refresh token. */
  readonly authorizationParameters?: Readonly<Record<string, string>>;
  /** The tools of its MCP servers that agents never get, such as ones that end its sign-in. */
  readonly hiddenTools?: readonly string[];
  /**
   * Makes the secret that Golem keeps, and its label, from what the person pastes, such as a cURL command of Slack's
   * web app; it throws when that does not work. Without it, Golem keeps the pasted secret, and the person names it.
   */
  readonly secretFrom?: (
    input: string
  ) => Promise<{ readonly secret: string; readonly label: string }>;
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

/** The turn a tool call is part of: the person it is for, whose own credentials come first, also private ones. */
export interface Turn {
  readonly userId: string | null;
  readonly signal?: AbortSignal;
  /** The files that its tools can take, such as attachments; a routine has none. */
  readonly file?: FileOf;
  /**
   * Resolves when the person allows the action of `text`, and throws when they do not; `approverId` null lets any
   * member answer. Only an agent in a thread can ask, so a routine's script cannot act as a person.
   */
  readonly approve?: (text: string, approverId: string | null) => Promise<void>;
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
  /** The email address of the server's owner, who alone sets Golem's own OAuth clients. */
  readonly owner?: string | null;
  /** Called when the connector tools of a workspace may change: a credential there changed. */
  readonly changed?: (workspaceId: string) => void;
  readonly catalog?: readonly Connector[];
  /** Connects to an MCP server; tests pass an in-memory one. */
  readonly transport?: (url: URL, provider: OAuthClientProvider) => Transport;
}

/** What a credential of a sign-in keeps, encrypted: its OAuth client, and its tokens once someone signed in. */
interface McpGrant {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

/** A sign-in that someone started: on a sign-in page, or by entering a device's code on their phone. */
interface PendingSignIn {
  readonly provider?: GrantProvider;
  readonly device?: {
    readonly credentialId: string;
    readonly phone: string;
    readonly linked: Promise<void>;
  };
  readonly workspaceId: string;
  readonly user: User;
  readonly connector: Connector;
  readonly expiresAt: number;
}

/** The live credential `?1` of the person `?3` in the workspace `?2`. */
const OWN_CREDENTIAL =
  "id = ?1 AND workspace_id = ?2 AND owner_id = ?3 AND deleted_at IS NULL";
const SIGN_IN_MS = 10 * 60 * 1000;
/** How long finishing a device's link waits for the person to enter its code. */
const LINK_WAIT_MS = 60 * 1000;

/**
 * The outside systems that agents use. A person connects an integration in their Settings, in the workspace, and each
 * credential is private, for their own turns, until they share it with the turns of every member. Each credential is
 * an account, such as a Google address: a turn uses the account that a tool call names, else the newest of the person
 * it is for, else the newest shared one. Only its owner shares or deletes a credential. Secrets never leave the server.
 */
export class Integrations {
  private readonly catalog: readonly Connector[];
  /** The sign-ins in progress, by their OAuth `state`, or by the credential id of a device's link. */
  private readonly signIns = new Map<string, PendingSignIn>();
  /** One MCP client for each credential and server, by `<credential id> <server>`, connected at first use. */
  private readonly clients = new Map<string, Promise<Client>>();
  /** The access token of each credential of an `oauth` connector, until shortly before it expires. */
  private readonly accessTokens = new Map<
    string,
    Promise<{ token: string; expiresAt: number }>
  >();

  constructor(
    private readonly database: Database,
    private readonly secrets: Secrets,
    private readonly workspaces: Workspaces,
    private readonly options: IntegrationsOptions
  ) {
    this.catalog = options.catalog ?? integrationCatalog();
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

  /** The integrations, with the credentials that the person sees in the workspace: the shared ones and their own. */
  list(workspaceId: string, user: User): Integration[] {
    this.workspaces.requireMember(workspaceId, user);
    const credentials = this.summaries(
      "c.workspace_id = ?1 AND (c.shared = 1 OR c.owner_id = ?2)",
      workspaceId,
      user.id
    );
    const owner = this.isOwner(user);
    return this.catalog.flatMap((connector) => {
      const clientId = connector.registered
        ? (this.oauthClient(connector.id)?.clientId ?? null)
        : null;
      if (connector.registered && !(clientId || owner)) {
        return [];
      }
      return {
        id: connector.id,
        name: connector.name,
        connect: connectionOf(connector),
        secretLabel: connector.secretLabel,
        labeled: !(connector.secretFrom || connector.username),
        address: connector.address ?? false,
        username: connector.username ?? null,
        guide: connector.guide ?? [],
        client: connector.registered ? { clientId, changeable: owner } : null,
        credentials: credentials
          .filter((credential) => credential.integration === connector.id)
          .map(({ integration: _, ...credential }) => credential),
      };
    });
  }

  private summaries(
    where: string,
    ...params: string[]
  ): (CredentialSummary & { integration: string })[] {
    const rows = this.database
      .query(
        `SELECT c.id, c.integration, c.label, c.owner_id AS ownerId, u.name AS ownerName, c.shared, c.created_at AS createdAt FROM credential c JOIN user u ON u.id = c.owner_id WHERE ${where} AND c.deleted_at IS NULL ORDER BY c.created_at`
      )
      .all(...params) as (Omit<CredentialSummary, "shared"> & {
      integration: string;
      shared: number;
    })[];
    return rows.map((row) => ({ ...row, shared: row.shared === 1 }));
  }

  /**
   * Sets Golem's own OAuth client of an integration whose sign-in server does not register clients; only the server's
   * owner does. The next sign-in uses it; the sign-ins before keep the client they signed in with.
   */
  setClient(user: User, integrationId: string, client: OAuthClient): void {
    if (!this.isOwner(user)) {
      throw new HttpError(403, "Only the server's owner sets the client");
    }
    if (!this.connector(integrationId).registered) {
      throw notFound();
    }
    this.database
      .query(
        "INSERT INTO oauth_client (integration, client_id, secret, changed_by, changed_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (integration) DO UPDATE SET client_id = ?2, secret = ?3, changed_by = ?4, changed_at = ?5"
      )
      .run(
        integrationId,
        required(client.clientId, "Client ID").trim(),
        this.secrets.encrypt(
          required(client.clientSecret, "Client secret").trim()
        ),
        user.id,
        Date.now()
      );
  }

  async addCredential(
    workspaceId: string,
    user: User,
    integrationId: string,
    input: {
      label?: string;
      secret: string;
      address?: string;
      username?: string;
    }
  ): Promise<CredentialSummary> {
    this.workspaces.requireMember(workspaceId, user);
    const connector = this.connector(integrationId);
    if (connectionOf(connector) !== "secret") {
      throw new HttpError(400, "Connect it by signing in");
    }
    const pasted = required(input.secret, "Secret");
    const username = connector.username
      ? required(input.username?.trim(), connector.username)
      : undefined;
    const secret = username
      ? JSON.stringify({ username, secret: pasted })
      : pasted;
    if (connector.secretFrom) {
      const made = await connector.secretFrom(secret).catch((error: Error) => {
        throw new HttpError(400, error.message, { cause: error });
      });
      return this.insertCredential(
        workspaceId,
        user,
        integrationId,
        made.label,
        made.secret
      );
    }
    return this.insertCredential(
      workspaceId,
      user,
      integrationId,
      username ?? required(input.label, "Label"),
      connector.address
        ? JSON.stringify({ address: serverAddress(input.address), secret })
        : secret
    );
  }

  /**
   * Starts a sign-in. For a sign-in: registers Golem with the sign-in server unless Golem has its own client, and
   * returns the page where the person signs in, which ends at an address that the person gives to `finishConnect`. For
   * a device: returns the code that the person enters on the phone of `phone`.
   */
  async connect(
    workspaceId: string,
    user: User,
    integrationId: string,
    phone?: string
  ): Promise<{ url: string } | { code: string }> {
    this.workspaces.requireMember(workspaceId, user);
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
        workspaceId,
        user,
        connector,
        expiresAt: now + SIGN_IN_MS,
      });
      return { code };
    }
    if (connectionOf(connector) !== "sign-in") {
      throw notFound();
    }
    const state = randomUUID();
    const client = connector.registered
      ? this.oauthClient(connector.id)
      : undefined;
    if (connector.registered && !client) {
      throw new HttpError(
        400,
        `The server's owner has not set the client of ${connector.name}`
      );
    }
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
      workspaceId,
      user,
      connector,
      expiresAt: now + SIGN_IN_MS,
    });
    return { url: provider.authorizationUrl.href };
  }

  /**
   * Ends the person's own sign-in in the workspace where it started, and keeps it as a private credential. A sign-in ends with the
   * address where its page ended, and works once; a device's link when the person entered its code.
   */
  async finishConnect(
    workspaceId: string,
    user: User,
    integrationId: string,
    address?: string
  ): Promise<CredentialSummary> {
    this.workspaces.requireMember(workspaceId, user);
    if (this.connector(integrationId).device) {
      return this.finishLink(workspaceId, user, integrationId);
    }
    const query = URL.parse(required(address, "Address"))?.searchParams;
    const state = query?.get("state") ?? "";
    const pending = this.signIns.get(state);
    if (
      !(
        pending?.provider &&
        this.isOwn(pending, workspaceId, user, integrationId)
      )
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
      workspaceId,
      user,
      connector.id,
      emailOf(provider.grant.tokens?.id_token) ?? connector.name,
      JSON.stringify(provider.grant)
    );
  }

  /** Waits a while for the person's newest link of a device in the workspace, and keeps it as a private credential. */
  private async finishLink(
    workspaceId: string,
    user: User,
    integrationId: string
  ): Promise<CredentialSummary> {
    const pending = [...this.signIns.values()]
      .filter((candidate) =>
        this.isOwn(candidate, workspaceId, user, integrationId)
      )
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
      workspaceId,
      user,
      integrationId,
      phone,
      phone,
      credentialId
    );
  }

  private isOwn(
    pending: PendingSignIn,
    workspaceId: string,
    user: User,
    integrationId: string
  ): boolean {
    return (
      pending.workspaceId === workspaceId &&
      pending.user.id === user.id &&
      pending.connector.id === integrationId &&
      pending.expiresAt >= Date.now()
    );
  }

  private insertCredential(
    workspaceId: string,
    user: User,
    integrationId: string,
    label: string,
    secret: string,
    id: string = randomUUID()
  ): CredentialSummary {
    const credential = {
      id,
      label,
      ownerId: user.id,
      ownerName: user.name,
      shared: false,
      createdAt: Date.now(),
    };
    this.database
      .query(
        "INSERT INTO credential (id, workspace_id, integration, owner_id, label, shared, secret, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
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

  /** Shares the person's credential with the turns of every member, or makes it private to their own turns again. */
  setShared(
    workspaceId: string,
    user: User,
    credentialId: string,
    shared: boolean
  ): CredentialSummary {
    this.workspaces.requireMember(workspaceId, user);
    const { changes } = this.database
      .query(`UPDATE credential SET shared = ?4 WHERE ${OWN_CREDENTIAL}`)
      .run(credentialId, workspaceId, user.id, shared ? 1 : 0);
    if (changes === 0) {
      throw notFound();
    }
    this.options.changed?.(workspaceId);
    const { integration: _, ...credential } = this.summaries(
      "c.id = ?",
      credentialId
    )[0]!;
    return credential;
  }

  /** Deletes the person's credential. */
  deleteCredential(
    workspaceId: string,
    user: User,
    credentialId: string
  ): void {
    this.workspaces.requireMember(workspaceId, user);
    const row = this.database
      .query(`SELECT integration FROM credential WHERE ${OWN_CREDENTIAL}`)
      .get(credentialId, workspaceId, user.id) as {
      integration: string;
    } | null;
    if (!row) {
      throw notFound();
    }
    // Nothing is removed: the credential stays encrypted, and no tool reads it again.
    this.database
      .query("UPDATE credential SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), credentialId);
    this.closeClient(credentialId);
    this.accessTokens.delete(credentialId);
    const connector = this.catalog.find(({ id }) => id === row.integration);
    if (connector?.device) {
      this.unlink(connector, credentialId);
    }
    this.options.changed?.(workspaceId);
  }

  /**
   * The tools of every connector for the agents and routines of a workspace: of each connector that someone connected
   * there, with `<id>_accounts`, which lists the accounts that a turn can name.
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
              ...(tool.approval
                ? {
                    approval: async (args, credential, signal, file) =>
                      tool.approval!(
                        args as never,
                        await this.secretOf(connector, credential),
                        signal,
                        file
                      ),
                  }
                : {}),
              call: async (args, credential, signal, file, allowed) =>
                tool.execute(
                  args as never,
                  await this.secretOf(connector, credential),
                  signal,
                  file,
                  allowed
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

  /** What a connector's own tool gets of a credential: a device's store, a fresh access token, or the secret. */
  private async secretOf(
    connector: Connector,
    credential: Credential
  ): Promise<string> {
    if (connector.device) {
      return this.store(credential.id);
    }
    return connector.oauth
      ? (await this.accessToken(connector, credential)).token
      : credential.secret;
  }

  /**
   * The access token of a credential of an `oauth` connector, from the cache until a minute before it expires; else
   * the refresh token gets a new one, and the new grant replaces the stored one.
   */
  private accessToken(
    connector: Connector,
    credential: Credential
  ): Promise<{ token: string; expiresAt: number }> {
    const cached = this.accessTokens.get(credential.id);
    if (cached) {
      return cached.then((access) =>
        access.expiresAt > Date.now()
          ? access
          : this.refreshedToken(connector, credential)
      );
    }
    return this.refreshedToken(connector, credential);
  }

  private refreshedToken(
    connector: Connector,
    credential: Credential
  ): Promise<{ token: string; expiresAt: number }> {
    const provider = new GrantProvider(
      JSON.parse(credential.secret),
      connector,
      undefined,
      (grant) => this.saveGrant(credential.id, grant)
    );
    const refreshing = signIn(connector, provider).then(() => {
      const { tokens } = provider.grant;
      // A refresh that failed leaves the SDK wanting a new sign-in.
      if (provider.authorizationUrl || !tokens) {
        throw new Error(
          `${connector.name} ended the sign-in. Connect it again in Settings.`
        );
      }
      return {
        token: tokens.access_token,
        expiresAt: Date.now() + ((tokens.expires_in ?? 0) - 60) * 1000,
      };
    });
    refreshing.catch(() => this.accessTokens.delete(credential.id));
    this.accessTokens.set(credential.id, refreshing);
    return refreshing;
  }

  private saveGrant(credentialId: string, grant: McpGrant): void {
    this.database
      .query("UPDATE credential SET secret = ? WHERE id = ?")
      .run(this.secrets.encrypt(JSON.stringify(grant)), credentialId);
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
        const credential = this.credentialFor(
          workspaceId,
          connector,
          turn.userId,
          account
        );
        if (!tool.approval) {
          return tool.call(rest, credential, turn.signal, turn.file);
        }
        if (!turn.approve) {
          throw new Error(
            `Only an agent in a thread can use ${tool.name}, after a person allows it.`
          );
        }
        const allowed = await tool.approval(
          rest,
          credential,
          turn.signal,
          turn.file
        );
        await turn.approve(
          allowed,
          this.approverOf(workspaceId, credential, turn.userId)
        );
        return tool.call(rest, credential, turn.signal, turn.file, allowed);
      },
    };
  }

  private accountsTool(
    workspaceId: string,
    connector: Connector
  ): WorkspaceTool {
    return {
      name: `${connector.id}_accounts`,
      description: `The ${connector.name} accounts that the other ${connector.id}_ tools can use for this person, by \`account\`: their own first, newest first, then the ones that other members shared.`,
      parameters: Type.Object({}),
      execute: async (_args, turn) => {
        const person = this.turnPerson(workspaceId, turn.userId);
        return this.credentialRows(workspaceId, connector, person).map(
          (row) => ({
            account: row.label,
            of: row.owner_id === person ? "own" : "shared",
          })
        );
      },
    };
  }

  /**
   * The tools of a connector's MCP servers, named `<id>_<tool>`, as the newest shared sign-in lists them, else the
   * newest private one; the list has only names and schemas, and no tool call uses that sign-in for another person.
   * None of a server without a sign-in, or when it fails, so one shop that is down does not stop the agents.
   */
  private async mcpTools(
    workspaceId: string,
    connector: Connector
  ): Promise<AccountTool[]> {
    const row = this.database
      .query(
        "SELECT id, label, owner_id, secret FROM credential WHERE integration = ? AND workspace_id = ? AND deleted_at IS NULL ORDER BY shared DESC, created_at DESC, rowid DESC LIMIT 1"
      )
      .get(connector.id, workspaceId) as CredentialRow | null;
    if (!row) {
      return [];
    }
    const lister = {
      id: row.id,
      ownerId: row.owner_id,
      secret: this.secrets.decrypt(row.secret),
    };
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
        (grant) => this.saveGrant(credential.id, grant)
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
   * person's newest, else the newest shared one.
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
      this.turnPerson(workspaceId, userId)
    );
    if (rows.length === 0) {
      throw new Error(
        `${connector.name} is not connected. Connect it in Settings, and share it for the turns of every member.`
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
    return {
      id: row.id,
      ownerId: row.owner_id,
      secret: this.secrets.decrypt(row.secret),
    };
  }

  /**
   * Who allows a call that acts with a credential: its owner, whom the call acts as, while a member; else the turn's
   * person. The owner of a shared credential allows it for another person's turn, as for a machine.
   */
  private approverOf(
    workspaceId: string,
    credential: Credential,
    userId: string | null
  ): string | null {
    return this.memberIds(workspaceId).includes(credential.ownerId)
      ? credential.ownerId
      : userId;
  }

  /** The credentials of a connector that a turn of `person` uses: their own, newest first, then the shared ones. */
  private credentialRows(
    workspaceId: string,
    connector: Connector,
    person: string | null
  ): CredentialRow[] {
    return this.database
      .query(
        "SELECT id, label, owner_id, secret FROM credential WHERE integration = ?1 AND workspace_id = ?2 AND deleted_at IS NULL AND (shared = 1 OR owner_id = ?3) ORDER BY owner_id IS NOT ?3, created_at DESC, rowid DESC"
      )
      .all(connector.id, workspaceId, person) as CredentialRow[];
  }

  /** The person of a turn, when they are a member of its workspace. */
  private turnPerson(
    workspaceId: string,
    userId: string | null
  ): string | null {
    return userId && this.memberIds(workspaceId).includes(userId)
      ? userId
      : null;
  }

  private memberIds(workspaceId: string): string[] {
    return this.workspaces
      .members(workspaceId, this.workspaces.agentMember(workspaceId))
      .map((member) => member.userId);
  }

  private oauthClient(integrationId: string): OAuthClient | undefined {
    const row = this.database
      .query("SELECT client_id, secret FROM oauth_client WHERE integration = ?")
      .get(integrationId) as { client_id: string; secret: Uint8Array } | null;
    return row
      ? {
          clientId: row.client_id,
          clientSecret: this.secrets.decrypt(row.secret),
        }
      : undefined;
  }

  private isOwner(user: User): boolean {
    return user.email.toLowerCase() === this.options.owner?.toLowerCase();
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

/** A credential as a tool call uses it: its id, its owner, and its decrypted secret. */
interface Credential {
  readonly id: string;
  readonly ownerId: string;
  readonly secret: string;
}

interface CredentialRow {
  readonly id: string;
  readonly label: string;
  readonly owner_id: string;
  readonly secret: Uint8Array;
}

/** A connector's tool before it gets its `account`: it runs with the credential that the call chose. */
interface AccountTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly outputSchema?: TSchema;
  readonly approval?: (
    args: unknown,
    credential: Credential,
    signal: AbortSignal | undefined,
    file?: FileOf
  ) => Promise<string>;
  readonly call: (
    args: unknown,
    credential: Credential,
    signal: AbortSignal | undefined,
    file?: FileOf,
    allowed?: string
  ) => Promise<unknown>;
}

function connectionOf(connector: Connector): Integration["connect"] {
  if (connector.device) {
    return "phone";
  }
  return connector.mcp || connector.oauth ? "sign-in" : "secret";
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

/**
 * Runs the MCP SDK's sign-in step, which refreshes the tokens when the grant has a refresh token; a refusal of the
 * sign-in server reaches the person with its reason.
 */
async function signIn(
  connector: Connector,
  provider: GrantProvider,
  authorizationCode?: string
): Promise<void> {
  try {
    await auth(provider, {
      // Without the metadata of a protected resource, the SDK takes this as the sign-in server.
      serverUrl: connector.oauth ?? connector.mcp![0]!,
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
  private verifier = "";

  constructor(
    readonly grant: McpGrant,
    private readonly connector: Connector,
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

  /** The endpoints of a server that does not publish them, such as Netatmo's; else the SDK discovers them. */
  discoveryState() {
    const endpoints = this.connector.oauthEndpoints;
    const server = this.connector.oauth;
    return endpoints && server
      ? {
          authorizationServerUrl: server,
          authorizationServerMetadata: {
            issuer: server,
            authorization_endpoint: endpoints.authorization,
            token_endpoint: endpoints.token,
            response_types_supported: ["code"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
          },
        }
      : undefined;
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

/** The address of a person's own server, such as `http://homeassistant.local:8123`. */
function serverAddress(address: string | undefined): string {
  const url = URL.parse(required(address, "Address"));
  if (!(url && (url.protocol === "http:" || url.protocol === "https:"))) {
    throw new HttpError(400, "Address must start with http:// or https://");
  }
  return url.href;
}

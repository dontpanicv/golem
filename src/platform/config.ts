import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Golem keeps everything in two folders:
 * - `config/`: what Golem needs to start: `golem.toml` and `secret.key`. Keep a copy somewhere safe, apart from
 *   the data backup, because `secret.key` decrypts the credentials stored in `data/`.
 * - `data/`: everything Golem stores: databases, markdown, files, indexes, models, and logs. Back this up offsite.
 */
export interface Config {
  readonly configDirectory: string;
  readonly dataDirectory: string;
  /** The network address Golem listens on; `127.0.0.1` lets only a proxy on the same machine reach it. */
  readonly host: string;
  readonly port: number;
  /** The address people open; better-auth uses it for links and origin checks. */
  readonly baseUrl: string;
  /** The public address of public artifacts, such as https://a.example.com, when the rest of Golem is private. */
  readonly shareUrl: string | null;
  /** The only people who may sign in. */
  readonly allowedEmails: readonly string[];
  /** The Google OAuth client for sign-in; see google-sign-in.md. */
  readonly google: OAuthClient;
  /**
   * Golem's own OAuth clients of the integrations whose servers do not register clients, by integration id; see
   * docs/integrations.md. Golem offers such an integration only with its client.
   */
  readonly integrations: Readonly<Record<string, OAuthClient>>;
  /** The APNs key that sends pushes to the iOS app, kept in `config/apns.p8`; `null` sends none. */
  readonly apns: {
    readonly keyId: string;
    readonly teamId: string;
    /** The iOS app's bundle id. */
    readonly topic: string;
  } | null;
}

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

const TEMPLATE = `# Golem configuration. Golem created this file on first start; edit it and restart Golem.

# The address people open, for example https://golem.example.com. Google sign-in needs https, or localhost.
base_url = "http://localhost:3000"
port = 3000

# The network address Golem listens on. 127.0.0.1 lets only this machine reach it, for example through a proxy;
# 0.0.0.0 opens it to every network the machine is on.
host = "127.0.0.1"

# The public address of public artifact links, for example https://a.example.com, when the rest of Golem is private.
# That address answers only artifact links; docs/artifacts-sharing.md shows how to set it up.
# share_url = "https://a.example.com"

# The Google accounts that may sign in, for example ["anna@gmail.com"]. Nobody else can.
allowed_emails = []

# The Google OAuth client for sign-in. google-sign-in.md shows how to create it.
[google]
client_id = ""
client_secret = ""

# The OAuth clients of Google (Gmail, Calendar, Drive) and Slack, which people sign in to in Settings.
# docs/integrations.md shows how to create them.
# [integrations.google]
# client_id = ""
# client_secret = ""
# [integrations.slack]
# client_id = ""
# client_secret = ""

# The Apple Push Notification service key that sends notifications to the iOS app. Put the key in config/apns.p8.
# [apns]
# key_id = "ABC123DEFG"
# team_id = "DEF123GHIJ"
# topic = "dev.golem.app"
`;

/** Reads `config/golem.toml`, creating `config/` and `data/` with defaults on first start. */
export async function readConfig(
  env: Record<string, string | undefined> = process.env
): Promise<Config> {
  const configDirectory = resolve(env.GOLEM_CONFIG ?? "config");
  const dataDirectory = resolve(env.GOLEM_DATA ?? "data");
  for (const directory of [configDirectory, dataDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Only Golem's user reads the secrets and the family's data, also on an install that an older version made.
    chmodSync(directory, 0o700);
  }
  const file = Bun.file(join(configDirectory, "golem.toml"));
  if (!(await file.exists())) {
    await Bun.write(file, TEMPLATE);
  }
  const values = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
  const google = (values.google ?? {}) as Record<string, unknown>;
  const integrations = (values.integrations ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const apns = values.apns as Record<string, unknown> | undefined;
  return {
    configDirectory,
    dataDirectory,
    host: text(values.host ?? "127.0.0.1", "host"),
    port: integer(values.port ?? 3000, "port"),
    baseUrl: text(values.base_url ?? "http://localhost:3000", "base_url"),
    shareUrl:
      values.share_url === undefined
        ? null
        : new URL(text(values.share_url, "share_url")).origin,
    allowedEmails: list(values.allowed_emails ?? [], "allowed_emails").map(
      (email) => email.trim().toLowerCase()
    ),
    google: {
      clientId: text(google.client_id, "google.client_id"),
      clientSecret: text(google.client_secret, "google.client_secret"),
    },
    integrations: Object.fromEntries(
      Object.entries(integrations).map(([id, client]) => [
        id,
        {
          clientId: text(client.client_id, `integrations.${id}.client_id`),
          clientSecret: text(
            client.client_secret,
            `integrations.${id}.client_secret`
          ),
        },
      ])
    ),
    apns: apns
      ? {
          keyId: text(apns.key_id, "apns.key_id"),
          teamId: text(apns.team_id, "apns.team_id"),
          topic: text(apns.topic, "apns.topic"),
        }
      : null,
  };
}

function integer(value: unknown, key: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`config/golem.toml: ${key} must be a whole number`);
  }
  return value as number;
}

function text(value: unknown, key: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`config/golem.toml: ${key} must be a text value`);
  }
  return value;
}

function list(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`config/golem.toml: ${key} must be a list of text values`);
  }
  return value;
}

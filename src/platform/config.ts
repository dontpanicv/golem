import { mkdirSync } from "node:fs";
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
  readonly port: number;
  /** The address people open; better-auth uses it for links and origin checks. */
  readonly baseUrl: string;
  /** The only people who may sign in. */
  readonly allowedEmails: readonly string[];
  /** The Google OAuth client for sign-in; see google-sign-in.md. */
  readonly google: { readonly clientId: string; readonly clientSecret: string };
}

const TEMPLATE = `# Golem configuration. Golem created this file on first start; edit it and restart Golem.

# The address people open, for example https://golem.example.com. Google sign-in needs https, or localhost.
base_url = "http://localhost:3000"
port = 3000

# The Google accounts that may sign in, for example ["anna@gmail.com"]. Nobody else can.
allowed_emails = []

# The Google OAuth client for sign-in. google-sign-in.md shows how to create it.
[google]
client_id = ""
client_secret = ""
`;

/** Reads `config/golem.toml`, creating `config/` and `data/` with defaults on first start. */
export async function readConfig(
  env: Record<string, string | undefined> = process.env
): Promise<Config> {
  const configDirectory = resolve(env.GOLEM_CONFIG ?? "config");
  const dataDirectory = resolve(env.GOLEM_DATA ?? "data");
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });
  const file = Bun.file(join(configDirectory, "golem.toml"));
  if (!(await file.exists())) {
    await Bun.write(file, TEMPLATE);
  }
  const values = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
  const google = (values.google ?? {}) as Record<string, unknown>;
  return {
    configDirectory,
    dataDirectory,
    port: integer(values.port ?? 3000, "port"),
    baseUrl: text(values.base_url ?? "http://localhost:3000", "base_url"),
    allowedEmails: list(values.allowed_emails ?? [], "allowed_emails").map(
      (email) => email.trim().toLowerCase()
    ),
    google: {
      clientId: text(google.client_id, "google.client_id"),
      clientSecret: text(google.client_secret, "google.client_secret"),
    },
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

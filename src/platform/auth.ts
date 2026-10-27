import type { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { bearer, organization } from "better-auth/plugins";

export interface AuthOptions {
  readonly database: Database;
  readonly secret: string;
  readonly baseUrl: string;
  readonly allowedEmails: readonly string[];
  readonly google: { readonly clientId: string; readonly clientSecret: string };
}

export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/**
 * Accounts and workspaces. Workspaces are better-auth organizations, so one person can belong to several.
 * People sign in only with Google, and only with an allowed email; there is no other way to create an account.
 */
export function createAuth(options: AuthOptions) {
  const allowed = new Set(options.allowedEmails);
  const requireAllowed = (email: string | undefined) => {
    if (!(email && allowed.has(email.toLowerCase()))) {
      throw new APIError("FORBIDDEN", {
        code: "EMAIL_NOT_ALLOWED",
        message: "This Google account cannot sign in to Golem.",
      });
    }
  };
  return betterAuth({
    database: options.database,
    secret: options.secret,
    baseURL: options.baseUrl,
    trustedOrigins: [options.baseUrl],
    socialProviders: {
      google: {
        clientId: options.google.clientId,
        clientSecret: options.google.clientSecret,
      },
    },
    // Accounts made with a password before Google sign-in have unverified emails; Google verifies the email.
    account: { accountLinking: { requireLocalEmailVerified: false } },
    onAPIError: { errorURL: `${options.baseUrl}/login` },
    plugins: [
      organization({
        // Deletes are soft: `Workspaces.delete` sets `deletedAt`, and better-auth's own delete would remove the rows.
        disableOrganizationDeletion: true,
        schema: {
          organization: {
            additionalFields: {
              deletedAt: { type: "number", required: false, input: false },
            },
          },
        },
      }),
      bearer(),
    ],
    databaseHooks: {
      user: { create: { before: async (user) => requireAllowed(user.email) } },
      // Also on every sign-in; `currentUser` checks the list on every request too.
      session: {
        create: {
          before: async (session) => {
            const user = options.database
              .query("SELECT email FROM user WHERE id = ?")
              .get(session.userId) as { email: string } | null;
            requireAllowed(user?.email);
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export async function migrateAuth(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/**
 * The signed-in user of a request, from its session cookie or bearer token. A session whose email left
 * `allowedEmails` signs in nobody.
 */
export async function currentUser(
  auth: Auth,
  request: Request,
  allowedEmails: readonly string[]
): Promise<User | undefined> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!(session && allowedEmails.includes(session.user.email.toLowerCase()))) {
    return undefined;
  }
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  };
}

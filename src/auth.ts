import type { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { bearer, organization } from "better-auth/plugins";

export type AuthOptions = {
	readonly database: Database;
	readonly secret: string;
	readonly baseUrl: string;
	readonly allowedEmails: readonly string[];
};

export type User = { readonly id: string; readonly name: string; readonly email: string };

/**
 * Accounts and workspaces. Workspaces are better-auth organizations, so one person can belong to several.
 * Email and password for now; Google sign-in comes later through OIDC.
 */
export function createAuth(options: AuthOptions) {
	const allowed = new Set(options.allowedEmails);
	return betterAuth({
		database: options.database,
		secret: options.secret,
		baseURL: options.baseUrl,
		trustedOrigins: [options.baseUrl],
		emailAndPassword: { enabled: true },
		plugins: [organization(), bearer()],
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						const { count } = options.database.query("SELECT count(*) AS count FROM user").get() as { count: number };
						if (count > 0 && !allowed.has(user.email.toLowerCase())) {
							throw new APIError("FORBIDDEN", { message: "Sign-up is closed. Ask the owner to allow your email." });
						}
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

/** The signed-in user of a request, from its session cookie or bearer token. */
export async function currentUser(auth: Auth, request: Request): Promise<User | undefined> {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) return undefined;
	return { id: session.user.id, name: session.user.name, email: session.user.email };
}

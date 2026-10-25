import { resolve } from "node:path";

export type Config = {
	/** Directory for the database, the secret key, and thread storage. */
	readonly dataDirectory: string;
	readonly port: number;
	/** The address people open; better-auth uses it for links and origin checks. */
	readonly baseUrl: string;
	/** Who may sign up once the first account exists. */
	readonly allowedEmails: readonly string[];
};

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
	const port = Number(env.GOLEM_PORT ?? 3000);
	return {
		dataDirectory: resolve(env.GOLEM_DATA ?? "data"),
		port,
		baseUrl: env.GOLEM_BASE_URL ?? `http://localhost:${port}`,
		allowedEmails: (env.GOLEM_ALLOWED_EMAILS ?? "")
			.split(",")
			.map((email) => email.trim().toLowerCase())
			.filter(Boolean),
	};
}

import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { type Auth, createAuth, currentUser, migrateAuth, type User } from "./auth.ts";
import type { Config } from "./config.ts";
import { migrate, openDatabase } from "./database.ts";
import { Llm, type LlmProvider } from "./llm.ts";
import type { Embedder } from "./search/embedder.ts";
import { Indexer } from "./search/indexer.ts";
import { Secrets } from "./secrets.ts";
import { Threads } from "./threads.ts";
import { HttpError, Workspaces } from "./workspaces.ts";

export type App = {
	readonly config: Config;
	readonly database: Database;
	readonly auth: Auth;
	readonly llm: Llm;
	readonly threads: Threads;
	readonly workspaces: Workspaces;
	readonly indexer: Indexer;
};

/** `embedder` gives search its meaning; without one, search and recall use keywords only. */
export async function createApp(config: Config, llmProvider: LlmProvider, secrets?: Secrets, embedder: Embedder | null = null): Promise<App> {
	mkdirSync(config.dataDirectory, { recursive: true });
	const resolvedSecrets = secrets ?? (await Secrets.load(config.configDirectory));
	const database = openDatabase(join(config.dataDirectory, "golem.sqlite"));
	const auth = createAuth({
		database,
		secret: resolvedSecrets.authSecret,
		baseUrl: config.baseUrl,
		allowedEmails: config.allowedEmails,
		google: config.google,
	});
	await migrateAuth(auth);
	migrate(database);
	const llm = new Llm(database, resolvedSecrets, llmProvider);
	const threads: Threads = new Threads(config.dataDirectory, llm, {
		recall: (workspaceId, query, limit) => indexer.search(workspaceId, query, limit),
		changed: (workspaceId) => indexer.touch(workspaceId),
	});
	const indexer = new Indexer(config.dataDirectory, database, threads, embedder);
	const workspaces = new Workspaces(database, auth, resolvedSecrets, threads);
	return { config, database, auth, llm, threads, workspaces, indexer };
}

export async function closeApp(app: App): Promise<void> {
	app.indexer.close();
	await app.threads.closeAll();
	app.database.close();
}

export type RouteInput = {
	readonly app: App;
	readonly request: Request;
	readonly params: Readonly<Record<string, string | undefined>>;
};
export type AuthedInput = RouteInput & { readonly user: User };
export type Handler = (input: RouteInput) => Promise<Response>;
export type Route = readonly [method: "GET" | "POST" | "PUT" | "DELETE" | "*", path: `/${string}`, handler: Handler];

/** Registers plain `Request` → `Response` handlers on the Effect router. */
export function routes(app: App, table: readonly Route[]) {
	return HttpRouter.use((router) =>
		Effect.forEach(table, ([method, path, handler]) =>
			router.add(method, path, (request) =>
				Effect.gen(function* () {
					const params = yield* HttpRouter.params;
					const web = yield* HttpServerRequest.toWeb(request);
					const response = yield* Effect.promise(() =>
						handler({ app, request: web, params }).catch((error: unknown) => errorResponse(error)),
					);
					return HttpServerResponse.fromWeb(response);
				}).pipe(Effect.catch((error) => Effect.sync(() => (console.error("request failed", error), HttpServerResponse.empty({ status: 400 }))))),
			),
		),
	);
}

/** Runs `handler` for a signed-in user; others get `onSignedOut`. */
export function signedIn(handler: (input: AuthedInput) => Promise<Response>, onSignedOut: () => Response): Handler {
	return async (input) => {
		const user = await currentUser(input.app.auth, input.request);
		return user ? handler({ ...input, user }) : onSignedOut();
	};
}

/** A redirect that keeps the cookies better-auth set, such as the session or the Google sign-in state. */
export function withCookies(result: { headers: Headers }, location: string): Response {
	const headers = new Headers({ location });
	for (const cookie of result.headers.getSetCookie()) headers.append("set-cookie", cookie);
	return new Response(null, { status: 303, headers });
}

export function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function errorResponse(error: unknown): Response {
	if (error instanceof HttpError) return json({ error: error.message }, error.status);
	console.error(error);
	return json({ error: "Something went wrong" }, 500);
}

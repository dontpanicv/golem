import { type AuthedInput, type Handler, json, type Route, signedIn } from "./app.ts";
import { HttpError } from "./workspaces.ts";

/** The JSON API for the iOS app. See docs/api.md. */
export const apiRoutes: readonly Route[] = [
	["*", "/api/auth/*", ({ app, request }) => app.auth.handler(request)],

	["GET", "/api/v1/me", api(async ({ app, user }) => json({ user, workspaces: app.workspaces.list(user) }))],
	["POST", "/api/v1/workspaces", api(async ({ app, user, body }) => json(await app.workspaces.create(user, body.name as string)))],
	[
		"GET",
		"/api/v1/workspaces/:workspace",
		api(async ({ app, user, params }) =>
			json({ workspace: app.workspaces.get(params.workspace!, user), channels: app.workspaces.channels(params.workspace!, user) }),
		),
	],
	[
		"POST",
		"/api/v1/workspaces/:workspace/channels",
		api(async ({ app, user, params, body }) => json(app.workspaces.createChannel(params.workspace!, user, body.name as string))),
	],
	[
		"POST",
		"/api/v1/workspaces/:workspace/threads",
		api(async ({ app, user, params, body }) =>
			json(await app.workspaces.createThread(params.workspace!, user, body.channelId as string, body.text as string)),
		),
	],
	[
		"GET",
		"/api/v1/threads/:thread",
		api(async ({ app, user, params }) => {
			const thread = app.workspaces.thread(params.thread!, user);
			return json({ thread: summary(thread), ...(await app.threads.messages(thread)) });
		}),
	],
	[
		"GET",
		"/api/v1/threads/:thread/events",
		api(async ({ app, user, params }) => {
			const thread = app.workspaces.thread(params.thread!, user);
			return eventStream((send) => app.threads.watch(thread, (state) => send("thread", { thread: summary(thread), ...state })));
		}),
	],
	[
		"POST",
		"/api/v1/threads/:thread/messages",
		api(async ({ app, user, params, body }) => {
			await app.workspaces.send(params.thread!, user, body.text as string);
			return new Response(null, { status: 204 });
		}),
	],
	["GET", "/api/v1/workspaces/:workspace/members", api(async ({ app, user, params }) => json(app.workspaces.members(params.workspace!, user)))],
	[
		"POST",
		"/api/v1/workspaces/:workspace/members",
		api(async ({ app, user, params, body }) => json(await app.workspaces.addMember(params.workspace!, user, body.email as string))),
	],
	[
		"GET",
		"/api/v1/workspaces/:workspace/integrations",
		api(async ({ app, user, params }) => json(app.workspaces.integrations(params.workspace!, user))),
	],
	[
		"PUT",
		"/api/v1/workspaces/:workspace/integrations/:integration",
		api(async ({ app, user, params, body }) =>
			json(app.workspaces.setEnabled(params.workspace!, user, params.integration!, body.enabled === true)),
		),
	],
	[
		"POST",
		"/api/v1/workspaces/:workspace/integrations/:integration/credentials",
		api(async ({ app, user, params, body }) =>
			json(
				app.workspaces.addCredential(params.workspace!, user, params.integration!, {
					label: body.label as string,
					secret: body.secret as string,
					shared: body.shared === true,
				}),
			),
		),
	],
	[
		"DELETE",
		"/api/v1/workspaces/:workspace/credentials/:credential",
		api(async ({ app, user, params }) => {
			app.workspaces.deleteCredential(params.workspace!, user, params.credential!);
			return new Response(null, { status: 204 });
		}),
	],
	["GET", "/api/v1/llm", api(async ({ app }) => json(await app.llm.status()))],
	["POST", "/api/v1/llm/login", api(async ({ app }) => json(await app.llm.startLogin()))],
	["POST", "/api/v1/llm/logout", api(async ({ app }) => json(await app.llm.logout()))],
	[
		"PUT",
		"/api/v1/llm/model",
		api(async ({ app, body }) => {
			try {
				app.llm.setModel(body.model as string);
			} catch (error) {
				throw new HttpError(400, (error as Error).message);
			}
			return json(await app.llm.status());
		}),
	],
];

type ApiInput = AuthedInput & { readonly body: Record<string, unknown> };

function api(handler: (input: ApiInput) => Promise<Response>): Handler {
	return signedIn(
		async (input) => {
			const body = input.request.method === "GET" || input.request.method === "DELETE" ? {} : await readBody(input.request);
			return handler({ ...input, body });
		},
		() => json({ error: "Sign in first" }, 401),
	);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
	const text = await request.text();
	if (!text.trim()) return {};
	const body = await Promise.resolve().then(() => JSON.parse(text)).catch(() => undefined);
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Send a JSON object");
	return body as Record<string, unknown>;
}

function summary(thread: { id: string; channelId: string; title: string; updatedAt: number }) {
	return { id: thread.id, channelId: thread.channelId, title: thread.title, updatedAt: thread.updatedAt };
}

/** A server-sent events response that runs until the client disconnects. */
export function eventStream(
	start: (send: (event: string, data: unknown) => void) => Promise<() => Promise<void>>,
): Response {
	const encoder = new TextEncoder();
	let stop: (() => Promise<void>) | undefined;
	let ping: ReturnType<typeof setInterval> | undefined;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: string, data: unknown) =>
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			stop = await start(send);
			// Comments keep proxies and idle timers from closing a quiet stream.
			ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 15_000);
		},
		async cancel() {
			clearInterval(ping);
			await stop?.();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

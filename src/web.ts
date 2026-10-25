import { resolve, sep } from "node:path";
import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import { type AuthedInput, type Handler, type Route, type RouteInput, signedIn } from "./app.ts";
import type { User } from "./auth.ts";
import { designPage } from "./ui/design.ts";
import {
	authPage,
	channelPage,
	llmCard,
	newWorkspacePage,
	settingsPage,
	threadPage,
	workspaceSettingsPage,
} from "./ui/pages.ts";
import type { Toast } from "./ui/components.ts";
import type { ShellContext } from "./ui/shell.ts";
import { transcript } from "./ui/shell.ts";
import { HttpError } from "./workspaces.ts";

const publicDirectory = resolve(import.meta.dir, "../public");

/** The web app: HTML from the server, live parts over Datastar. */
export const webRoutes: readonly Route[] = [
	["GET", "/assets/*", async ({ request }) => asset(request)],
	["GET", "/design", async () => html(designPage())],

	["GET", "/login", async ({ request }) => html(authPage("login", toastOf(request)))],
	["GET", "/signup", async ({ request }) => html(authPage("signup", toastOf(request)))],
	["POST", "/login", form(async ({ app, fields }) => withCookies(await app.auth.api.signInEmail({ body: { email: fields.email!, password: fields.password! }, returnHeaders: true }), "/"), "/login")],
	[
		"POST",
		"/signup",
		form(
			async ({ app, fields }) =>
				withCookies(
					await app.auth.api.signUpEmail({ body: { name: fields.name!, email: fields.email!, password: fields.password! }, returnHeaders: true }),
					"/",
				),
			"/signup",
		),
	],
	["POST", "/logout", page(async ({ app, request }) => withCookies(await app.auth.api.signOut({ headers: request.headers, returnHeaders: true }), "/login"))],

	[
		"GET",
		"/",
		page(async ({ app, user }) => {
			const [first] = app.workspaces.list(user);
			return redirect(first ? `/w/${first.id}` : "/workspaces/new");
		}),
	],
	["GET", "/workspaces/new", page(async ({ app, user, request }) => html(newWorkspacePage({ user, workspaces: app.workspaces.list(user), toast: toastOf(request) })))],
	["POST", "/workspaces", action("/workspaces/new", async ({ app, user, fields }) => `/w/${(await app.workspaces.create(user, fields.name!)).id}`)],

	[
		"GET",
		"/w/:workspace",
		page(async ({ app, user, params }) => {
			const [first] = app.workspaces.channels(params.workspace!, user);
			return redirect(first ? `/w/${params.workspace}/c/${first.id}` : `/w/${params.workspace}/settings`);
		}),
	],
	[
		"POST",
		"/w/:workspace/channels",
		action(
			({ params }) => `/w/${params.workspace}`,
			async ({ app, user, params, fields }) => `/w/${params.workspace}/c/${app.workspaces.createChannel(params.workspace!, user, fields.name!).id}`,
		),
	],
	[
		"GET",
		"/w/:workspace/c/:channel",
		page(async (input) => {
			const context = shellContext(input, { channelId: input.params.channel });
			const channel = context.channels!.find((candidate) => candidate.id === input.params.channel);
			if (!channel) throw new HttpError(404, "Not found");
			return html(channelPage(context, channel));
		}),
	],
	[
		"POST",
		"/w/:workspace/c/:channel/threads",
		action(
			({ params }) => `/w/${params.workspace}/c/${params.channel}`,
			async ({ app, user, params, fields }) =>
				`/w/${params.workspace}/t/${(await app.workspaces.createThread(params.workspace!, user, params.channel!, fields.text!)).id}`,
		),
	],
	[
		"GET",
		"/w/:workspace/t/:thread",
		page(async (input) => {
			const thread = threadIn(input);
			const context = shellContext(input, { channelId: thread.channelId, threadId: thread.id });
			const channel = context.channels!.find((candidate) => candidate.id === thread.channelId)!;
			return html(threadPage(context, channel, thread));
		}),
	],
	[
		"GET",
		"/w/:workspace/t/:thread/events",
		page(async (input) => {
			const thread = threadIn(input);
			let stop: (() => Promise<void>) | undefined;
			return ServerSentEventGenerator.stream(
				async (stream) => {
					stop = await input.app.threads.watch(thread, (state) => void stream.patchElements(transcript(state)));
				},
				{ keepalive: true, onAbort: () => void stop?.() },
			);
		}),
	],
	[
		"POST",
		"/w/:workspace/t/:thread/messages",
		page(async (input) => {
			const thread = threadIn(input);
			const signals = await ServerSentEventGenerator.readSignals(input.request);
			const text = signals.success ? signals.signals.message : undefined;
			if (typeof text !== "string" || !text.trim()) return new Response(null, { status: 400 });
			await input.app.workspaces.send(thread.id, input.user, text);
			return ServerSentEventGenerator.stream((stream) => void stream.patchSignals(JSON.stringify({ message: "" })));
		}),
	],

	[
		"GET",
		"/w/:workspace/settings",
		page(async (input) => {
			const { app, user, params } = input;
			const members = app.workspaces.members(params.workspace!, user);
			const integrations = app.workspaces.integrations(params.workspace!, user);
			return html(workspaceSettingsPage(shellContext(input, {}), members, integrations));
		}),
	],
	[
		"POST",
		"/w/:workspace/members",
		action(settingsOf, async ({ app, user, params, fields }) => {
			const member = await app.workspaces.addMember(params.workspace!, user, fields.email!);
			return withNotice(settingsOf({ params }), `${member.name} joined the workspace`);
		}),
	],
	[
		"POST",
		"/w/:workspace/integrations/:integration",
		action(settingsOf, async ({ app, user, params, fields }) => {
			app.workspaces.setEnabled(params.workspace!, user, params.integration!, fields.enabled === "true");
			return settingsOf({ params });
		}),
	],
	[
		"POST",
		"/w/:workspace/integrations/:integration/credentials",
		action(settingsOf, async ({ app, user, params, fields }) => {
			app.workspaces.addCredential(params.workspace!, user, params.integration!, {
				label: fields.label!,
				secret: fields.secret!,
				shared: fields.shared === "true",
			});
			return withNotice(settingsOf({ params }), "Credential added");
		}),
	],
	[
		"POST",
		"/w/:workspace/credentials/:credential/delete",
		action(settingsOf, async ({ app, user, params }) => {
			app.workspaces.deleteCredential(params.workspace!, user, params.credential!);
			return withNotice(settingsOf({ params }), "Credential deleted");
		}),
	],

	[
		"GET",
		"/settings",
		page(async ({ app, user, request }) => {
			// Keep the first workspace in the sidebar, so settings feel like part of the app.
			const workspaces = app.workspaces.list(user);
			const workspace = workspaces[0];
			const channels = workspace ? app.workspaces.channels(workspace.id, user) : undefined;
			return html(settingsPage({ user, workspaces, workspace, channels, toast: toastOf(request) }, await app.llm.status()));
		}),
	],
	[
		"GET",
		"/settings/llm",
		page(async ({ app }) => {
			const card = llmCard(await app.llm.status());
			return ServerSentEventGenerator.stream((stream) => void stream.patchElements(card));
		}),
	],
	["POST", "/settings/llm/login", action("/settings", async ({ app }) => (await app.llm.startLogin(), "/settings"))],
	["POST", "/settings/llm/logout", action("/settings", async ({ app }) => (await app.llm.logout(), "/settings"))],
	[
		"POST",
		"/settings/llm/model",
		action("/settings", async ({ app, fields }) => {
			try {
				app.llm.setModel(fields.model!);
			} catch (error) {
				throw new HttpError(400, (error as Error).message);
			}
			return withNotice("/settings", `New threads and replies use ${fields.model}`);
		}),
	],
];

type FormInput = RouteInput & { readonly fields: Record<string, string | undefined> };
type AuthedFormInput = AuthedInput & { readonly fields: Record<string, string | undefined> };

/** A page for signed-in people; others go to the login page. Not found errors render as 404. */
function page(handler: (input: AuthedInput) => Promise<Response>): Handler {
	return signedIn(
		async (input) => {
			try {
				return await handler(input);
			} catch (error) {
				if (error instanceof HttpError && error.status === 404) return new Response("Not found", { status: 404 });
				throw error;
			}
		},
		() => redirect("/login"),
	);
}

/** A form post by a signed-in person: redirects to the returned path, or back to `back` with the error. */
function action(
	back: string | ((input: { params: RouteInput["params"] }) => string),
	handler: (input: AuthedFormInput) => Promise<string>,
): Handler {
	return page(async (input) => {
		rejectCrossOrigin(input.request);
		const fields = await formFields(input.request);
		try {
			return redirect(await handler({ ...input, fields }));
		} catch (error) {
			if (error instanceof HttpError && error.status !== 404) {
				return redirect(withError(typeof back === "string" ? back : back(input), error.message));
			}
			throw error;
		}
	});
}

/** A form post before sign-in, such as login: errors from better-auth go back to `back`. */
function form(handler: (input: FormInput) => Promise<Response>, back: string): Handler {
	return async (input) => {
		rejectCrossOrigin(input.request);
		const fields = await formFields(input.request);
		try {
			return await handler({ ...input, fields });
		} catch (error) {
			const message = (error as { body?: { message?: string } }).body?.message ?? (error as Error).message;
			return redirect(withError(back, message));
		}
	};
}

function shellContext(input: AuthedInput, current: ShellContext["current"]): ShellContext {
	const { app, user, params } = input;
	const workspace = app.workspaces.get(params.workspace!, user);
	return {
		user,
		workspaces: app.workspaces.list(user),
		workspace,
		channels: app.workspaces.channels(workspace.id, user),
		current,
		toast: toastOf(input.request),
	};
}

function threadIn(input: AuthedInput) {
	const thread = input.app.workspaces.thread(input.params.thread!, input.user);
	if (thread.workspaceId !== input.params.workspace) throw new HttpError(404, "Not found");
	return thread;
}

function settingsOf({ params }: { params: RouteInput["params"] }): string {
	return `/w/${params.workspace}/settings`;
}

/** Form posts must come from this site: browsers send `Origin` on cross-site posts. */
function rejectCrossOrigin(request: Request): void {
	const origin = request.headers.get("origin");
	if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "Cross-site request");
}

async function formFields(request: Request): Promise<Record<string, string | undefined>> {
	const data = await request.formData().catch(() => new FormData());
	return Object.fromEntries([...data.entries()].map(([key, value]) => [key, typeof value === "string" ? value : undefined]));
}

function withCookies(result: { headers: Headers }, location: string): Response {
	const headers = new Headers({ location });
	for (const cookie of result.headers.getSetCookie()) headers.append("set-cookie", cookie);
	return new Response(null, { status: 303, headers });
}

/** The toast a redirect asked for with `?error=` or `?notice=`. */
function toastOf(request: Request): Toast {
	const params = new URL(request.url).searchParams;
	const error = params.get("error");
	if (error) return { tone: "error", text: error };
	const notice = params.get("notice");
	return notice ? { tone: "success", text: notice } : null;
}

function withNotice(path: string, message: string): string {
	return `${path}?notice=${encodeURIComponent(message)}`;
}

function withError(path: string, message: string): string {
	return `${path}?error=${encodeURIComponent(message)}`;
}

function redirect(location: string): Response {
	return new Response(null, { status: 303, headers: { location } });
}

function html(body: string): Response {
	return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Serves a file from `public/`; paths that leave it are not found. */
async function asset(request: Request): Promise<Response> {
	const path = resolve(publicDirectory, decodeURIComponent(new URL(request.url).pathname.slice("/assets/".length)));
	const file = Bun.file(path);
	if (!path.startsWith(publicDirectory + sep) || !(await file.exists())) return new Response("Not found", { status: 404 });
	return new Response(file);
}

export type { User };

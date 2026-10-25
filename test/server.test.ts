import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { HttpRouter } from "effect/http";
import { apiRoutes } from "../src/api.ts";
import { type App, closeApp, createApp, routes } from "../src/app.ts";
import { Secrets } from "../src/secrets.ts";
import { webRoutes } from "../src/web.ts";

const faux = fauxProvider();
const model = faux.getModel();
let app: App;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let dataDirectory: string;

beforeAll(async () => {
	dataDirectory = await mkdtemp(join(tmpdir(), "golem-"));
	app = await createApp(
		{ dataDirectory, port: 0, baseUrl: "http://golem.test", allowedEmails: ["bob@example.com", "eve@example.com"] },
		{ provider: faux.provider, name: "Test model", models: [model.id], defaultModel: model.id },
		Secrets.forTests(),
	);
	({ handler, dispose } = HttpRouter.toWebHandler(routes(app, [...apiRoutes, ...webRoutes]), { disableLogger: true }));
});

afterAll(async () => {
	await dispose();
	await closeApp(app);
	await rm(dataDirectory, { recursive: true, force: true });
});

function call(path: string, options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
	const headers = new Headers(options.headers);
	if (options.token) headers.set("authorization", `Bearer ${options.token}`);
	if (options.body !== undefined) headers.set("content-type", "application/json");
	return handler(
		new Request(`http://golem.test${path}`, {
			method: options.method ?? (options.body === undefined ? "GET" : "POST"),
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		}),
	);
}

async function signUp(name: string, email: string): Promise<Response> {
	return call("/api/auth/sign-up/email", { body: { name, email, password: "correct horse battery" } });
}

async function token(response: Response): Promise<string> {
	expect(response.status).toBe(200);
	return response.headers.get("set-auth-token")!;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const value = await read();
		if (done(value)) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out");
}

let alice: string;
let bob: string;
let workspaceId: string;
let threadId: string;

test("the first person signs up; later sign-ups need an allowed email", async () => {
	alice = await token(await signUp("Alice", "alice@example.com"));
	expect((await signUp("Mallory", "mallory@example.com")).status).toBe(403);
	bob = await token(await signUp("Bob", "bob@example.com"));
	expect((await call("/api/v1/me")).status).toBe(401);
});

test("a new workspace has a general channel", async () => {
	const workspace = await (await call("/api/v1/workspaces", { token: alice, body: { name: "Family" } })).json() as any;
	workspaceId = workspace.id;
	const detail = await (await call(`/api/v1/workspaces/${workspaceId}`, { token: alice })).json() as any;
	expect(detail.channels.map((channel: { name: string }) => channel.name)).toEqual(["general"]);
	const duplicate = await call(`/api/v1/workspaces/${workspaceId}/channels`, { token: alice, body: { name: "General" } });
	expect(duplicate.status).toBe(409);
});

test("a thread is a Pi Durable session that knows who wrote each message", async () => {
	faux.setResponses([fauxAssistantMessage("Saturday works.")]);
	const { channels } = await (await call(`/api/v1/workspaces/${workspaceId}`, { token: alice })).json() as any;
	const thread = await (
		await call(`/api/v1/workspaces/${workspaceId}/threads`, { token: alice, body: { channelId: channels[0].id, text: "Plan the cabin trip" } })
	).json() as any;
	threadId = thread.id;
	expect(thread.title).toBe("Plan the cabin trip");
	const state = await until(
		async () => (await call(`/api/v1/threads/${threadId}`, { token: alice })).json() as any,
		(state) => state.messages.length === 2 && !state.running,
	);
	expect(state.messages.map((message: { author: string; text: string }) => [message.author, message.text])).toEqual([
		["Alice", "Plan the cabin trip"],
		["Golem", "Saturday works."],
	]);
});

test("workspaces are isolated until someone adds you", async () => {
	expect((await call(`/api/v1/workspaces/${workspaceId}`, { token: bob })).status).toBe(404);
	expect((await call(`/api/v1/threads/${threadId}`, { token: bob })).status).toBe(404);
	expect((await call(`/api/v1/threads/${threadId}/messages`, { token: bob, body: { text: "hi" } })).status).toBe(404);
	expect(((await (await call("/api/v1/me", { token: bob })).json()) as any).workspaces).toEqual([]);

	const added = await call(`/api/v1/workspaces/${workspaceId}/members`, { token: alice, body: { email: "BOB@example.com" } });
	expect(added.status).toBe(200);
	expect((await call(`/api/v1/threads/${threadId}`, { token: bob })).status).toBe(200);
});

test("credentials are private or shared, and secrets never leave the server", async () => {
	const base = `/api/v1/workspaces/${workspaceId}`;
	await call(`${base}/integrations/github/credentials`, { token: alice, body: { label: "Alice's", secret: "alice-secret", shared: false } });
	const shared = await (
		await call(`${base}/integrations/github/credentials`, { token: alice, body: { label: "Family", secret: "family-secret", shared: true } })
	).json() as any;

	const bobsView = await (await call(`${base}/integrations`, { token: bob })).text();
	expect(bobsView).toContain("Family");
	expect(bobsView).not.toContain("Alice's");
	expect(bobsView).not.toContain("family-secret");
	expect(bobsView).not.toContain("alice-secret");

	const user = (email: string) => app.database.query("SELECT id, name, email FROM user WHERE email = ?").get(email) as never;
	expect(app.workspaces.usableCredentials(workspaceId, user("bob@example.com"))).toEqual([]);
	await call(`${base}/integrations/github`, { method: "PUT", token: bob, body: { enabled: true } });
	expect(app.workspaces.usableCredentials(workspaceId, user("bob@example.com")).map((c) => c.secret)).toEqual(["family-secret"]);

	expect((await call(`${base}/credentials/${shared.id}`, { method: "DELETE", token: bob })).status).toBe(404);
	expect((await call(`${base}/credentials/${shared.id}`, { method: "DELETE", token: alice })).status).toBe(204);
});

test("the LLM provider is shared by everyone", async () => {
	const llm = await (await call("/api/v1/llm", { token: bob })).json() as any;
	expect(llm).toMatchObject({ provider: "Test model", model: model.id, login: null });
	expect((await call("/api/v1/llm/model", { method: "PUT", token: bob, body: { model: "nope" } })).status).toBe(400);
});

test("the web app signs in with a form and keeps cross-site posts out", async () => {
	expect((await call("/")).headers.get("location")).toBe("/login");
	const login = await handler(
		new Request("http://golem.test/login", {
			method: "POST",
			body: new URLSearchParams({ email: "alice@example.com", password: "correct horse battery" }),
		}),
	);
	expect(login.status).toBe(303);
	const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
	expect(cookie).toContain("session_token");

	const home = await call("/", { headers: { cookie } });
	expect(home.headers.get("location")).toBe(`/w/${workspaceId}`);
	const thread = await call(`/w/${workspaceId}/t/${threadId}`, { headers: { cookie } });
	expect(await thread.text()).toContain("Plan the cabin trip");

	const crossSite = await handler(
		new Request(`http://golem.test/w/${workspaceId}/channels`, {
			method: "POST",
			headers: { cookie, origin: "https://evil.example" },
			body: new URLSearchParams({ name: "pwned" }),
		}),
	);
	expect(crossSite.status).toBe(403);
	expect((await call("/assets/..%2Fpackage.json")).status).toBe(404);
	expect((await call("/design")).status).toBe(200);
});

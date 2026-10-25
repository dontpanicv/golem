import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HttpRouter } from "effect/http";
import { apiRoutes } from "../src/api.ts";
import { type App, closeApp, createApp, routes } from "../src/app.ts";
import type { User } from "../src/auth.ts";
import type { Embedder } from "../src/search/embedder.ts";
import { chunk, isProse, WorkspaceIndex } from "../src/search/workspace-index.ts";
import { Secrets } from "../src/secrets.ts";
import { webRoutes } from "../src/web.ts";

/** Stands in for EmbeddingGemma: a hashed bag of words, so shared words mean similar vectors. */
function bagOfWords(input: string): Float32Array {
	const text = input.replace(/^task: search result \| query: /, "").replace(/^title: .*? \| text: /, "");
	const vector = new Float32Array(768);
	for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) vector[Number(Bun.hash(word) % 768n)]! += 1;
	const norm = Math.hypot(...vector) || 1;
	return vector.map((value) => value / norm);
}

// Pictures and audio become the word "picture" or "sound", so tests can find them by meaning.
const embedder: Embedder = {
	fingerprint: "test-bag-of-words",
	ready: () => true,
	embed: async (inputs) => inputs.map((input) => bagOfWords(typeof input === "string" ? input : "image" in input ? "picture" : "sound")),
};
const faux = fauxProvider();
const model = faux.getModel();
let app: App;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let dataDirectory: string;

beforeAll(async () => {
	dataDirectory = await mkdtemp(join(tmpdir(), "golem-search-"));
	app = await createApp(
		{
			configDirectory: dataDirectory,
			dataDirectory,
			port: 0,
			baseUrl: "http://golem.test",
			allowedEmails: ["anna@example.com", "otto@example.com"],
			google: { clientId: "test-client.apps.googleusercontent.com", clientSecret: "test-secret" },
		},
		{ provider: faux.provider, name: "Test model", defaultModel: model.id },
		Secrets.forTests(),
		embedder,
	);
	({ handler, dispose } = HttpRouter.toWebHandler(routes(app, [...apiRoutes, ...webRoutes]), { disableLogger: true }));
});

afterAll(async () => {
	await dispose();
	await closeApp(app);
	await rm(dataDirectory, { recursive: true, force: true });
});

async function person(name: string, email: string): Promise<{ user: User; token: string }> {
	const { internalAdapter } = await app.auth.$context;
	const created = await internalAdapter.createUser({ name, email, emailVerified: true }, { method: "oauth", oauth: { providerId: "google" } });
	return { user: { id: created.id, name, email }, token: (await internalAdapter.createSession(created.id)).token };
}

async function note(workspaceId: string, path: string, text: string): Promise<void> {
	const file = join(dataDirectory, "workspaces", workspaceId, "notes", path);
	await mkdir(join(file, ".."), { recursive: true });
	await Bun.write(file, text);
}

test("text is chunked with overlap, and only prose is embedded", () => {
	const parts = chunk("word ".repeat(1000), 1800, 200);
	expect(parts.length).toBe(3);
	expect(parts.every((part) => part.length <= 1800)).toBe(true);
	expect(isProse("The dentist moved Tuesday's appointment")).toBe(true);
	expect(isProse("INV-2026-0042 4711")).toBe(false);
});

test("an index finds by meaning and by words, and re-embeds when the model changes", async () => {
	const path = join(dataDirectory, "unit.sqlite");
	const index = new WorkspaceIndex(path, "model-a");
	const source = { kind: "note" as const, version: "1", updatedAt: 0 };
	await index.sync({ ...source, uri: "notes/dentist.md", title: "Dentist" }, async () => ({ segments: [{ key: "0", text: "The dentist appointment moved to Tuesday afternoon" }] }));
	await index.sync({ ...source, uri: "notes/car.md", title: "Car" }, async () => ({ segments: [{ key: "0", text: "Renew the car insurance before the end of the month" }] }));
	index.storeVectors(index.waiting(10).map((segment) => ({ id: segment.id, vector: bagOfWords(segment.text) })));
	expect(index.search("dentist tuesday", bagOfWords("dentist tuesday"), 5).map((result) => result.title)).toEqual(["Dentist"]);
	expect(index.search("insurance", null, 5).map((result) => result.title)).toEqual(["Car"]);
	index.close();
	const reopened = new WorkspaceIndex(path, "model-b");
	expect(reopened.counts().waiting).toBe(2);
	reopened.close();
});

test("search covers one workspace and never another, also through the agent's recall tool", async () => {
	const anna = await person("Anna", "anna@example.com");
	const otto = await person("Otto", "otto@example.com");
	const family = await app.workspaces.create(anna.user, "Family");
	const work = await app.workspaces.create(otto.user, "Work");
	await note(family.id, "health/dentist.md", "# Dentist\n\nThe dentist appointment moved to Tuesday afternoon.");
	await note(work.id, "secret.md", "# Payroll\n\nThe dentist plan for staff is confidential.");

	// The agent recalls before answering; the faux model records what the recall tool returned.
	let recalled = "";
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("recall", { query: "dentist appointment" })], { stopReason: "toolUse" }),
		(context) => {
			recalled = JSON.stringify(context.messages.at(-1));
			return fauxAssistantMessage("It moved to Tuesday afternoon.");
		},
	]);
	await app.indexer.scan(family.id);
	await app.indexer.scan(work.id);
	const channel = app.workspaces.channels(family.id, anna.user)[0]!;
	await app.workspaces.createThread(family.id, anna.user, channel.id, "When is the dentist?");
	for (let attempt = 0; attempt < 100 && !recalled; attempt++) await Bun.sleep(20);
	expect(recalled).toContain("Dentist");
	expect(recalled).not.toContain("Payroll");

	await app.indexer.scan(family.id);
	const found = await app.indexer.search(family.id, "dentist");
	expect(found.semantic).toBe(true);
	expect(found.results.map((result) => result.kind).sort()).toEqual(["note", "thread"]);
	expect(found.results.some((result) => result.title === "Payroll")).toBe(false);

	const response = await handler(
		new Request(`http://golem.test/api/v1/workspaces/${family.id}/search?q=dentist`, { headers: { authorization: `Bearer ${otto.token}` } }),
	);
	expect(response.status).toBe(404);
	const own = await handler(
		new Request(`http://golem.test/api/v1/workspaces/${work.id}/search?q=dentist`, { headers: { authorization: `Bearer ${otto.token}` } }),
	);
	expect(((await own.json()) as { results: { title: string }[] }).results.map((result) => result.title)).toEqual(["Payroll"]);

	const page = await handler(new Request(`http://golem.test/w/${family.id}/search?q=dentist`, { headers: { authorization: `Bearer ${anna.token}` } }));
	const html = await page.text();
	expect(html).toContain("Dentist");
	expect(html).not.toContain("Payroll");
});

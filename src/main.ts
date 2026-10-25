import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { apiRoutes } from "./api.ts";
import { closeApp, createApp, routes } from "./app.ts";
import { readConfig } from "./config.ts";
import type { LlmProvider } from "./llm.ts";
import { webRoutes } from "./web.ts";

/** ChatGPT through the Codex device login: one subscription for every workspace's agents. */
const chatGpt: LlmProvider = {
	provider: openaiCodexProvider(),
	name: "ChatGPT",
	models: Object.keys(OPENAI_CODEX_MODELS),
	defaultModel: "gpt-6.1-sol",
};

const config = readConfig();

const app = Layer.unwrap(
	Effect.acquireRelease(
		Effect.promise(() => createApp(config, chatGpt)),
		(app) => Effect.promise(() => closeApp(app)),
	).pipe(Effect.map((app) => routes(app, [...apiRoutes, ...webRoutes]))),
);

HttpRouter.serve(app).pipe(
	// Event streams stay open for as long as a page or the app watches a thread.
	Layer.provide(BunHttpServer.layer({ port: config.port, idleTimeout: 0 })),
	Layer.launch,
	BunRuntime.runMain,
);

import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { closeApp, createApp } from "./app/app.ts";
import { routes } from "./app/http.ts";
import { allRoutes } from "./app/routes.ts";
import type { LlmProvider } from "./llm.ts";
import { readConfig } from "./platform/config.ts";
import { LlamaEmbedder } from "./search/embedder.ts";

/** ChatGPT through the Codex device login: one subscription for every workspace's agents. */
const chatGpt: LlmProvider = {
  provider: openaiCodexProvider(),
  name: "ChatGPT",
  defaultModel: "gpt-6.1-sol",
};

const config = await readConfig();
// EmbeddingGemma 2 downloads on first start; until it runs, search uses keywords.
const embedder = new LlamaEmbedder(config.dataDirectory);

const server = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(async () => {
      embedder.start();
      const app = await createApp(config, chatGpt, undefined, embedder);
      app.indexer.start();
      return app;
    }),
    (app) =>
      Effect.promise(async () => {
        embedder.stop();
        await closeApp(app);
      })
  ).pipe(Effect.map((app) => routes(app, allRoutes)))
);

HttpRouter.serve(server).pipe(
  // Event streams stay open for as long as a page or the app watches a thread.
  Layer.provide(BunHttpServer.layer({ port: config.port, idleTimeout: 0 })),
  Layer.launch,
  BunRuntime.runMain
);

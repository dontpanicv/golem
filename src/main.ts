import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { checkRequirements, closeApp, createApp } from "./app/app.ts";
import { routes } from "./app/http.ts";
import { allRoutes } from "./app/routes.ts";
import type { LlmProvider } from "./llm/llm.ts";
import { readConfig } from "./platform/config.ts";
import { reportRequirements } from "./platform/requirements.ts";
import { LlamaEmbedder } from "./search/embedder.ts";

/** ChatGPT through the Codex device login: one subscription for every workspace's agents. */
const chatGpt: LlmProvider = {
  provider: openaiCodexProvider(),
  name: "ChatGPT",
  defaultModel: "gpt-6.1-sol",
  searchModel: "gpt-6-luna",
};

const config = await readConfig();
if (!reportRequirements(await checkRequirements())) {
  console.error(
    "Golem does not start until this machine has everything above."
  );
  process.exit(1);
}
// EmbeddingGemma 2 downloads on first start; until it runs, search uses keywords.
const embedder = new LlamaEmbedder(config.dataDirectory);

const server = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(async () => {
      embedder.start();
      const app = await createApp(config, chatGpt, undefined, embedder);
      app.indexer.start();
      app.routines.start();
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
  Layer.provide(
    BunHttpServer.layer({
      hostname: config.host,
      port: config.port,
      idleTimeout: 0,
    })
  ),
  Layer.launch,
  BunRuntime.runMain
);

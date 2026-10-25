import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import type { Route } from "../app/http.ts";
import { action, page } from "../app/web.ts";
import { llmCard } from "./pages.ts";

/** The LLM provider card on /settings: device login, logout, model, and effort. */
export const llmWebRoutes: readonly Route[] = [
  [
    "GET",
    "/settings/llm",
    page(async ({ app }) => {
      const card = llmCard(await app.llm.status());
      return ServerSentEventGenerator.stream((stream) => {
        stream.patchElements(card);
      });
    }),
  ],
  [
    "POST",
    "/settings/llm/login",
    action("/settings", async ({ app }) => {
      await app.llm.startLogin();
      return "/settings";
    }),
  ],
  [
    "POST",
    "/settings/llm/logout",
    action("/settings", async ({ app }) => {
      await app.llm.logout();
      return "/settings";
    }),
  ],
  [
    "POST",
    "/settings/llm/model",
    action("/settings", async ({ app, fields }) => {
      app.llm.setModel(fields.model!);
      return "/settings";
    }),
  ],
  [
    "POST",
    "/settings/llm/effort",
    action("/settings", async ({ app, fields }) => {
      app.llm.setEffort(fields.effort!);
      return "/settings";
    }),
  ],
];

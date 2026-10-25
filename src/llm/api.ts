import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** The shared LLM provider. */
export const llmApiRoutes: readonly Route[] = [
  ["GET", "/api/v1/llm", api(async ({ app }) => json(await app.llm.status()))],
  [
    "POST",
    "/api/v1/llm/login",
    api(async ({ app }) => json(await app.llm.startLogin())),
  ],
  [
    "POST",
    "/api/v1/llm/logout",
    api(async ({ app }) => json(await app.llm.logout())),
  ],
  [
    "PUT",
    "/api/v1/llm/model",
    api(async ({ app, body }) => {
      app.llm.setModel(body.model as string);
      return json(await app.llm.status());
    }),
  ],
  [
    "PUT",
    "/api/v1/llm/effort",
    api(async ({ app, body }) => {
      app.llm.setEffort(body.effort as string);
      return json(await app.llm.status());
    }),
  ],
];

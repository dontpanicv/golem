import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** The shared LLM provider. */
export const llmApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/llm",
    api(async ({ app, user }) => json(await app.llm.status(user))),
  ],
  [
    "POST",
    "/api/v1/llm/login",
    api(async ({ app, user }) => json(await app.llm.startLogin(user))),
  ],
  [
    "POST",
    "/api/v1/llm/logout",
    api(async ({ app, user }) => json(await app.llm.logout(user))),
  ],
  [
    "PUT",
    "/api/v1/llm/model",
    api(async ({ app, user, body }) => {
      app.llm.setModel(user, body.model as string);
      return json(await app.llm.status(user));
    }),
  ],
  [
    "PUT",
    "/api/v1/llm/effort",
    api(async ({ app, user, body }) => {
      app.llm.setEffort(user, body.effort as string);
      return json(await app.llm.status(user));
    }),
  ],
];

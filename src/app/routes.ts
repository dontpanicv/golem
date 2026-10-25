import { accountApiRoutes } from "../accounts/api.ts";
import { accountWebRoutes } from "../accounts/web.ts";
import { apiRoutes } from "../api.ts";
import { llmApiRoutes } from "../llm/api.ts";
import { llmWebRoutes } from "../llm/web.ts";
import { webRoutes } from "../web.ts";
import type { Route } from "./http.ts";

/** Every route of the server: the JSON API for the iOS app and the web app. */
export const allRoutes: readonly Route[] = [
  ...accountApiRoutes,
  ...apiRoutes,
  ...llmApiRoutes,
  ...accountWebRoutes,
  ...webRoutes,
  ...llmWebRoutes,
];

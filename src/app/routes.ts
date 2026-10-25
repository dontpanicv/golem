import { accountApiRoutes } from "../accounts/api.ts";
import { accountWebRoutes } from "../accounts/web.ts";
import { handsApiRoutes } from "../hands/api.ts";
import { handsWebRoutes } from "../hands/web.ts";
import { integrationApiRoutes } from "../integrations/api.ts";
import { integrationWebRoutes } from "../integrations/web.ts";
import { llmApiRoutes } from "../llm/api.ts";
import { llmWebRoutes } from "../llm/web.ts";
import { designPage } from "../platform/ui/design.ts";
import { searchApiRoutes } from "../search/api.ts";
import { searchWebRoutes } from "../search/web.ts";
import { settingsWebRoutes } from "../settings/web.ts";
import { threadApiRoutes } from "../threads/api.ts";
import { threadWebRoutes } from "../threads/web.ts";
import { workspaceApiRoutes } from "../workspaces/api.ts";
import { workspaceWebRoutes } from "../workspaces/web.ts";
import type { Route } from "./http.ts";
import { asset, html } from "./web.ts";

/**
 * Every route of the server. Each module has its JSON routes for the iOS app (see docs/api.md) and its web routes:
 * HTML from the server, live parts over Datastar.
 */
export const allRoutes: readonly Route[] = [
  ["GET", "/assets/*", async ({ request }) => asset(request)],
  ["GET", "/design", async () => html(designPage())],
  ...accountApiRoutes,
  ...accountWebRoutes,
  ...workspaceApiRoutes,
  ...workspaceWebRoutes,
  ...llmApiRoutes,
  ...llmWebRoutes,
  ...handsApiRoutes,
  ...handsWebRoutes,
  ...threadApiRoutes,
  ...threadWebRoutes,
  ...integrationApiRoutes,
  ...integrationWebRoutes,
  ...searchApiRoutes,
  ...searchWebRoutes,
  ...settingsWebRoutes,
];

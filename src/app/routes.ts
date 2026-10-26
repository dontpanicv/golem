import { accountApiRoutes } from "../accounts/api.ts";
import { artifactApiRoutes } from "../artifacts/api.ts";
import { artifactWebRoutes } from "../artifacts/web.ts";
import { handsApiRoutes } from "../hands/api.ts";
import { integrationApiRoutes } from "../integrations/api.ts";
import { llmApiRoutes } from "../llm/api.ts";
import { notificationApiRoutes } from "../notifications/api.ts";
import { routineApiRoutes } from "../routines/api.ts";
import { searchApiRoutes } from "../search/api.ts";
import { threadApiRoutes } from "../threads/api.ts";
import { workspaceApiRoutes } from "../workspaces/api.ts";
import type { Route } from "./http.ts";
import { appFile, appPage, asset } from "./web.ts";

/** The paths the web app routes in the browser; each one loads the app's page. */
const APP_PATHS = [
  "/",
  "/login",
  "/settings",
  "/workspaces/new",
  "/w/*",
] as const;

/**
 * Every route of the server: the JSON routes of each module (see docs/api.md), which the iOS app and the web app
 * both use, the web app itself, and the artifact links.
 */
export const allRoutes: readonly Route[] = [
  ["GET", "/assets/*", async ({ request }) => asset(request)],
  ["GET", "/app/*", async ({ request }) => appFile(request)],
  ...APP_PATHS.map((path): Route => ["GET", path, appPage]),
  ...accountApiRoutes,
  ...workspaceApiRoutes,
  ...llmApiRoutes,
  ...handsApiRoutes,
  ...integrationApiRoutes,
  ...artifactApiRoutes,
  ...artifactWebRoutes,
  ...notificationApiRoutes,
  ...threadApiRoutes,
  ...searchApiRoutes,
  ...routineApiRoutes,
];

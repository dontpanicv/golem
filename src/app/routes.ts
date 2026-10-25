import { apiRoutes } from "../api.ts";
import { webRoutes } from "../web.ts";
import type { Route } from "./http.ts";

/** Every route of the server: the JSON API for the iOS app and the web app. */
export const allRoutes: readonly Route[] = [...apiRoutes, ...webRoutes];

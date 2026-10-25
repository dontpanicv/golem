import { api } from "./app/api.ts";
import { json, type Route } from "./app/http.ts";

/** The JSON API for the iOS app. See docs/api.md. */
export const apiRoutes: readonly Route[] = [
  // The iOS app opens these in a browser sheet: Google sign-in, then `golem://signed-in` with a token or an error.
  // Any app can claim `golem://`, so only a sign-in started here hands over a token, and Google always asks.
  [
    "GET",
    "/api/v1/workspaces/:workspace/search",
    api(async ({ app, user, params, request }) => {
      // Membership first: a workspace's index is only ever searched by its members.
      const workspace = app.workspaces.requireMember(params.workspace!, user);
      const url = new URL(request.url);
      const limit = Math.min(
        Math.max(Number(url.searchParams.get("limit")) || 20, 1),
        50
      );
      return json(
        await app.indexer.search(
          workspace.id,
          url.searchParams.get("q") ?? "",
          limit
        )
      );
    }),
  ],
];

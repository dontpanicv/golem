import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** Search in one workspace, and the person's recent searches there. */
export const searchApiRoutes: readonly Route[] = [
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
          limit,
          user.id
        )
      );
    }),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/searches",
    api(async ({ app, user, params }) => {
      const workspace = app.workspaces.requireMember(params.workspace!, user);
      return json({
        searches: app.recentSearches.list(workspace.id, user.id),
      });
    }),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/searches",
    api(async ({ app, user, params, body }) => {
      const workspace = app.workspaces.requireMember(params.workspace!, user);
      return json({
        searches: app.recentSearches.add(workspace.id, user.id, body.query),
      });
    }),
  ],
];

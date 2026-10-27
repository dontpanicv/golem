import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** Search in one workspace, for the iOS app. */
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
];

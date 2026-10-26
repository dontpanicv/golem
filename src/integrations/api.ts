import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** The integrations and credentials of a workspace. */
export const integrationApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/integrations",
    api(async ({ app, user, params }) =>
      json(app.integrations.list(params.workspace!, user))
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/integrations/:integration/credentials",
    api(async ({ app, user, params, body }) =>
      json(
        app.integrations.addCredential(
          params.workspace!,
          user,
          params.integration!,
          { label: body.label as string, secret: body.secret as string }
        )
      )
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/integrations/:integration/connect",
    api(async ({ app, user, params, body }) =>
      json(
        await app.integrations.connect(
          params.workspace!,
          user,
          params.integration!,
          { app: body.app === true }
        )
      )
    ),
  ],
  // No session: the sign-in page of an MCP server sends people here, and the one-time `state` says whose sign-in it is.
  [
    "GET",
    "/api/v1/integrations/callback",
    async ({ app, request }) => {
      const query = new URL(request.url).searchParams;
      const { workspaceId, app: fromApp } =
        await app.integrations.finishConnect(
          query.get("state") ?? "",
          query.get("code")
        );
      const location = fromApp
        ? "golem://integration-connected"
        : `/w/${workspaceId}/settings`;
      return new Response(null, { status: 303, headers: { location } });
    },
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace/credentials/:credential",
    api(async ({ app, user, params }) => {
      app.integrations.deleteCredential(
        params.workspace!,
        user,
        params.credential!
      );
      return new Response(null, { status: 204 });
    }),
  ],
];

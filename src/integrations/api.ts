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
    api(async ({ app, user, params }) =>
      json(
        await app.integrations.connect(
          params.workspace!,
          user,
          params.integration!
        )
      )
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/integrations/:integration/sign-in",
    api(async ({ app, user, params, body }) =>
      json(
        await app.integrations.finishConnect(
          params.workspace!,
          user,
          params.integration!,
          body.address as string
        )
      )
    ),
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

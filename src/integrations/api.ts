import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** Each person's integrations and credentials in a workspace. */
export const integrationApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/integrations",
    api(async ({ app, user, params }) =>
      json(app.integrations.list(params.workspace!, user))
    ),
  ],
  [
    "PUT",
    "/api/v1/workspaces/:workspace/integrations/:integration",
    api(async ({ app, user, params, body }) =>
      json(
        app.integrations.setEnabled(
          params.workspace!,
          user,
          params.integration!,
          body.enabled === true
        )
      )
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
          {
            label: body.label as string,
            secret: body.secret as string,
            shared: body.shared === true,
          }
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

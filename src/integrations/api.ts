import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/**
 * The integrations and credentials of a place: a workspace's under `/workspaces/:workspace`, for every member's turns
 * there, and the person's own without it, for their turns in each of their workspaces. One table serves both. Golem's
 * own OAuth client of an integration is the server's.
 */
export const integrationApiRoutes: readonly Route[] = [
  [
    "PUT",
    "/api/v1/integrations/:integration/client",
    api(async ({ app, user, params, body }) => {
      app.integrations.setClient(user, params.integration!, {
        clientId: body.clientId as string,
        clientSecret: body.clientSecret as string,
      });
      return new Response(null, { status: 204 });
    }),
  ],
  ...(["/api/v1/workspaces/:workspace", "/api/v1"] as const).flatMap(
    (base): Route[] => [
      [
        "GET",
        `${base}/integrations`,
        api(async ({ app, user, params }) =>
          json(app.integrations.list(params.workspace ?? null, user))
        ),
      ],
      [
        "POST",
        `${base}/integrations/:integration/credentials`,
        api(async ({ app, user, params, body }) =>
          json(
            app.integrations.addCredential(
              params.workspace ?? null,
              user,
              params.integration!,
              {
                label: body.label as string,
                secret: body.secret as string,
                address: body.address as string | undefined,
              }
            )
          )
        ),
      ],
      [
        "POST",
        `${base}/integrations/:integration/connect`,
        api(async ({ app, user, params, body }) =>
          json(
            await app.integrations.connect(
              params.workspace ?? null,
              user,
              params.integration!,
              body.phone as string | undefined
            )
          )
        ),
      ],
      [
        "POST",
        `${base}/integrations/:integration/sign-in`,
        api(async ({ app, user, params, body }) =>
          json(
            await app.integrations.finishConnect(
              params.workspace ?? null,
              user,
              params.integration!,
              body.address as string | undefined
            )
          )
        ),
      ],
      [
        "DELETE",
        `${base}/credentials/:credential`,
        api(async ({ app, user, params }) => {
          app.integrations.deleteCredential(
            params.workspace ?? null,
            user,
            params.credential!
          );
          return new Response(null, { status: 204 });
        }),
      ],
    ]
  ),
];

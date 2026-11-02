import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { PUBLIC_KEY_PATH } from "./tesla.ts";

/**
 * The integrations, with the credentials that a person sees in the workspace: the shared ones and their own, which they
 * share or delete. Golem's own OAuth client of an integration is the server's.
 */
export const integrationApiRoutes: readonly Route[] = [
  // Tesla's Fleet API reads the key that Golem signs commands with here, at Golem's domain.
  [
    "GET",
    PUBLIC_KEY_PATH,
    async ({ app }) => {
      const key = app.integrations.publicKey("tesla");
      return key
        ? new Response(key, {
            headers: { "content-type": "application/x-pem-file" },
          })
        : new Response("Not found", { status: 404 });
    },
  ],
  [
    "PUT",
    "/api/v1/integrations/:integration/client",
    api(async ({ app, user, params, body }) => {
      await app.integrations.setClient(user, params.integration!, {
        clientId: body.clientId as string,
        clientSecret: body.clientSecret as string,
      });
      return new Response(null, { status: 204 });
    }),
  ],
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
        await app.integrations.addCredential(
          params.workspace!,
          user,
          params.integration!,
          {
            label: body.label as string | undefined,
            secret: body.secret as string,
            address: body.address as string | undefined,
            username: body.username as string | undefined,
          }
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
          {
            phone: body.phone as string | undefined,
            address: body.address as string | undefined,
          }
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
          body.address as string | undefined
        )
      )
    ),
  ],
  [
    "PUT",
    "/api/v1/workspaces/:workspace/credentials/:credential",
    api(async ({ app, user, params, body }) =>
      json(
        app.integrations.setShared(
          params.workspace!,
          user,
          params.credential!,
          body.shared === true
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

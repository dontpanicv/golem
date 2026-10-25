import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** The machines of a workspace, and the endpoints a machine pairs with (hands/docs/pairing.md). */
export const handsApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/machines",
    api(async ({ app, user, params }) =>
      json({
        machines: app.hands.machines(params.workspace!, user),
        pairing: app.hands.pairing(params.workspace!, user),
      })
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/machines/pairing",
    api(async ({ app, user, params }) =>
      json(await app.hands.startPairing(params.workspace!, user))
    ),
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace/machines/:machine",
    api(async ({ app, user, params }) => {
      app.hands.removeMachine(params.workspace!, user, params.machine!);
      return new Response(null, { status: 204 });
    }),
  ],
  // The machine itself calls these, without an account: the pairing code is the credential.
  [
    "GET",
    "/hands/:code",
    async ({ app, params }) =>
      new Response(await app.hands.installScript(params.code!), {
        headers: { "content-type": "text/x-shellscript; charset=utf-8" },
      }),
  ],
  [
    "GET",
    "/hands/:code/:binary",
    async ({ app, params }) => {
      const file = app.hands.binary(params.code!, params.binary!);
      return (await file.exists())
        ? new Response(file)
        : new Response("Not found", { status: 404 });
    },
  ],
  [
    "POST",
    "/hands/:code/pair",
    async ({ app, params, request }) => {
      const body = await request.json().catch(() => null);
      return json(app.hands.pair(params.code!, body));
    },
  ],
];

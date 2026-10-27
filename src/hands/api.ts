import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { readText } from "../app/web.ts";
import { HttpError } from "../platform/errors.ts";

/**
 * The machines of a place: a workspace's under `/workspaces/:workspace`, for every member's turns there, and the
 * person's own without it, for their turns in each of their workspaces. Then the endpoints a machine pairs with
 * (hands/docs/pairing.md).
 */
export const handsApiRoutes: readonly Route[] = [
  ...(["/api/v1/workspaces/:workspace", "/api/v1"] as const).flatMap(
    (base): Route[] => [
      [
        "GET",
        `${base}/machines`,
        api(async ({ app, user, params }) =>
          json({
            machines: app.hands.machines(params.workspace ?? null, user),
            pairing: app.hands.pairing(params.workspace ?? null, user),
          })
        ),
      ],
      [
        "POST",
        `${base}/machines/pairing`,
        api(async ({ app, user, params }) =>
          json(await app.hands.startPairing(params.workspace ?? null, user))
        ),
      ],
      [
        "DELETE",
        `${base}/machines/:machine`,
        api(async ({ app, user, params }) => {
          app.hands.removeMachine(
            params.workspace ?? null,
            user,
            params.machine!
          );
          return new Response(null, { status: 204 });
        }),
      ],
    ]
  ),
  [
    "PUT",
    "/api/v1/workspaces/:workspace/machines/:machine/trusted-members",
    api(async ({ app, user, params, body }) => {
      const { userIds } = body;
      if (
        !Array.isArray(userIds) ||
        userIds.some((userId) => typeof userId !== "string")
      ) {
        throw new HttpError(400, "userIds must be a list of user ids");
      }
      return json(
        app.hands.trustMembers(
          params.workspace!,
          user,
          params.machine!,
          userIds
        )
      );
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
      // Anyone may call this route, so it reads only a small body.
      const text = await readText(request, 64 * 1024);
      const body = await Promise.resolve()
        .then(() => JSON.parse(text))
        .catch(() => null);
      return json(app.hands.pair(params.code!, body));
    },
  ],
];

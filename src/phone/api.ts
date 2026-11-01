import { api, eventStream } from "../app/api.ts";
import type { Route } from "../app/http.ts";

/** The calls of agents' phone tools, which the iOS app gets on a stream while it is open, and answers. */
export const phoneApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/phone/calls",
    api(async ({ app, user }) =>
      eventStream(
        async (send) => {
          const close = app.phone.connect(user.id, (call) =>
            send("call", call)
          );
          return async () => close();
        },
        () => undefined
      )
    ),
  ],
  [
    "POST",
    "/api/v1/phone/calls/:call",
    api(async ({ app, user, params, body, files }) => {
      app.phone.answer(user.id, params.call!, {
        text: typeof body.text === "string" ? body.text : undefined,
        error: typeof body.error === "string" ? body.error : undefined,
        images: files,
      });
      return new Response(null, { status: 204 });
    }),
  ],
];

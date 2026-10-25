import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { currentUser, type User } from "../platform/auth.ts";
import { HttpError } from "../platform/errors.ts";
import type { App } from "./app.ts";

export interface RouteInput {
  readonly app: App;
  readonly request: Request;
  readonly params: Readonly<Record<string, string | undefined>>;
}
export type AuthedInput = RouteInput & { readonly user: User };
export type Handler = (input: RouteInput) => Promise<Response>;
export type Route = readonly [
  method: "GET" | "POST" | "PUT" | "DELETE" | "*",
  path: `/${string}`,
  handler: Handler,
];

/** Registers plain `Request` → `Response` handlers on the Effect router. */
export function routes(app: App, table: readonly Route[]) {
  return HttpRouter.use((router) =>
    Effect.forEach(table, ([method, path, handler]) =>
      router.add(method, path, (request) =>
        Effect.gen(function* () {
          const params = yield* HttpRouter.params;
          const web = yield* HttpServerRequest.toWeb(request);
          const response = yield* Effect.promise(() =>
            handler({ app, request: web, params }).catch((error: unknown) =>
              errorResponse(error)
            )
          );
          return HttpServerResponse.fromWeb(response);
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              console.error("request failed", error);
              return HttpServerResponse.empty({ status: 400 });
            })
          )
        )
      )
    )
  );
}

/** Runs `handler` for a signed-in user; others get `onSignedOut`. */
export function signedIn(
  handler: (input: AuthedInput) => Promise<Response>,
  onSignedOut: () => Response
): Handler {
  return async (input) => {
    const user = await currentUser(input.app.auth, input.request);
    return user ? handler({ ...input, user }) : onSignedOut();
  };
}

/** A redirect that keeps the cookies better-auth set, such as the session or the Google sign-in state. */
export function withCookies(
  result: { headers: Headers },
  location: string
): Response {
  const headers = new Headers({ location });
  for (const cookie of result.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.message }, error.status);
  }
  console.error(error);
  return json({ error: "Something went wrong" }, 500);
}

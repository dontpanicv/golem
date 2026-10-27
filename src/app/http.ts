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
  /** `share`: the route answers only on the host of `share_url`, and that host answers nothing else. */
  options?: { readonly share: true },
];

/** Registers plain `Request` → `Response` handlers on the Effect router. */
export function routes(app: App, table: readonly Route[]) {
  return HttpRouter.use((router) =>
    Effect.forEach(table, ([method, path, handler, options]) =>
      router.add(method, path, (request) =>
        Effect.gen(function* () {
          const params = yield* HttpRouter.params;
          const web = yield* HttpServerRequest.toWeb(request);
          const response = yield* Effect.promise(() =>
            onShareHost({ app, request: web }) === (options?.share === true)
              ? handler({ app, request: web, params }).catch((error: unknown) =>
                  errorResponse(error)
                )
              : Promise.resolve(new Response("Not found", { status: 404 }))
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

/** Whether a request came to the public host of `share_url`, which serves only public artifacts. */
export function onShareHost({
  app,
  request,
}: Pick<RouteInput, "app" | "request">): boolean {
  const { shareUrl } = app.config;
  // Bun builds the URL from the Host header, which Cloudflare's tunnel keeps.
  return (
    shareUrl !== null && new URL(request.url).host === new URL(shareUrl).host
  );
}

/** Runs `handler` for a signed-in user; others get `onSignedOut`. */
export function signedIn(
  handler: (input: AuthedInput) => Promise<Response>,
  onSignedOut: () => Response
): Handler {
  return async (input) => {
    const user = await currentUser(
      input.app.auth,
      input.request,
      input.app.config.allowedEmails
    );
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

/** Pictures, PDFs, plain text, audio, and video open in the browser. */
const INLINE_TYPES =
  /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain|audio\/|video\/)/;

/** A stored file. Other kinds download, so that an uploaded web page or SVG never runs on this site. */
export function fileResponse(path: string, name: string): Response {
  const file = Bun.file(path);
  const inline = INLINE_TYPES.test(file.type);
  return new Response(file, {
    headers: {
      "content-type": inline ? file.type : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.message }, error.status);
  }
  console.error(error);
  return json({ error: "Something went wrong" }, 500);
}

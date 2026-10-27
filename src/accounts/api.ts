import { json, type Route, withCookies } from "../app/http.ts";

const APP_SIGN_IN = "golem_app_sign_in";
/** Where a sign-in of the iOS app ends, on this server's https address. */
const SIGNED_IN = "/api/v1/sign-in/google/signed-in";

/** better-auth itself, and Google sign-in for the iOS app. */
export const accountApiRoutes: readonly Route[] = [
  [
    "*",
    "/api/auth/*",
    async ({ app, request }) => {
      // A person whose email left the list keeps only sign-out, so no session of theirs reaches better-auth's routes.
      const session = await app.auth.api.getSession({
        headers: request.headers,
      });
      if (
        session &&
        !app.config.allowedEmails.includes(session.user.email.toLowerCase()) &&
        new URL(request.url).pathname !== "/api/auth/sign-out"
      ) {
        return Response.json({ error: "Not signed in" }, { status: 401 });
      }
      return app.auth.handler(request);
    },
  ],
  // The iOS app opens these in a web authentication session: Google sign-in, then `signed-in` on this server's https
  // address with a one-time code or an error. The session gives that address only to the app that the
  // apple-app-site-association file names, and the code gives a token only with the verifier of the app's challenge.
  [
    "GET",
    "/api/v1/sign-in/google",
    async ({ app, request }) => {
      const flow = app.appSignIns.start(
        new URL(request.url).searchParams.get("challenge") ?? ""
      );
      const done = "/api/v1/sign-in/google/done";
      const google = await app.auth.api.signInSocial({
        body: {
          provider: "google",
          callbackURL: done,
          errorCallbackURL: done,
          additionalParams: { prompt: "select_account" },
        },
        returnHeaders: true,
      });
      const response = withCookies(google, google.response.url!);
      response.headers.append(
        "set-cookie",
        `${APP_SIGN_IN}=${flow}; Path=/api/v1/sign-in/google; Max-Age=600; HttpOnly; SameSite=Lax`
      );
      return response;
    },
  ],
  [
    "GET",
    "/api/v1/sign-in/google/done",
    async ({ app, request }) => {
      const flow = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
        APP_SIGN_IN
      );
      const session = await app.auth.api.getSession({
        headers: request.headers,
      });
      const params = new URL(request.url).searchParams;
      let result: Record<string, string>;
      try {
        result = {
          code: app.appSignIns.finish(
            flow ?? undefined,
            session?.session ?? null
          ),
        };
      } catch {
        result = {
          error:
            params.get("error_description") ??
            params.get("error") ??
            "Sign-in failed",
        };
      }
      const headers = new Headers({
        location: `${SIGNED_IN}?${new URLSearchParams(result)}`,
      });
      headers.append(
        "set-cookie",
        `${APP_SIGN_IN}=; Path=/api/v1/sign-in/google; Max-Age=0`
      );
      return new Response(null, { status: 303, headers });
    },
  ],
  // The app's web authentication session stops at this address; a browser without the app shows this page.
  [
    "GET",
    SIGNED_IN,
    async () =>
      new Response(
        '<!doctype html><meta name="viewport" content="width=device-width"><title>Golem</title><p>Open the Golem app to sign in.</p>',
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'none'",
            "referrer-policy": "no-referrer",
            "cache-control": "no-store",
          },
        }
      ),
  ],
  [
    "POST",
    "/api/v1/sign-in/google/token",
    async ({ app, request }) => {
      const body = (await request.json().catch(() => null)) as {
        code?: unknown;
        verifier?: unknown;
      } | null;
      return json({ token: app.appSignIns.token(body?.code, body?.verifier) });
    },
  ],
  // Lets the iOS app's web authentication session return to this server's https address (`webcredentials`).
  [
    "GET",
    "/.well-known/apple-app-site-association",
    async ({ app }) =>
      app.config.iosAppId
        ? json({ webcredentials: { apps: [app.config.iosAppId] } })
        : new Response("Not found", { status: 404 }),
  ],
];

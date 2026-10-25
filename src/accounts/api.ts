import { type Route, withCookies } from "../app/http.ts";

const APP_SIGN_IN = "golem_app_sign_in";

/** better-auth itself, and Google sign-in for the iOS app. */
export const accountApiRoutes: readonly Route[] = [
  ["*", "/api/auth/*", ({ app, request }) => app.auth.handler(request)],
  // The iOS app opens these in a browser sheet: Google sign-in, then `golem://signed-in` with a token or an error.
  // Any app can claim `golem://`, so only a sign-in started here hands over a token, and Google always asks.
  [
    "GET",
    "/api/v1/sign-in/google",
    async ({ app }) => {
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
        `${APP_SIGN_IN}=1; Path=/api/v1/sign-in/google; Max-Age=600; HttpOnly; SameSite=Lax`
      );
      return response;
    },
  ],
  [
    "GET",
    "/api/v1/sign-in/google/done",
    async ({ app, request }) => {
      const started = request.headers
        .get("cookie")
        ?.split("; ")
        .includes(`${APP_SIGN_IN}=1`);
      const session = started
        ? await app.auth.api.getSession({ headers: request.headers })
        : null;
      const params = new URL(request.url).searchParams;
      const result: Record<string, string> = session
        ? { token: session.session.token }
        : {
            error:
              params.get("error_description") ??
              params.get("error") ??
              "Sign-in failed",
          };
      const headers = new Headers({
        location: `golem://signed-in?${new URLSearchParams(result)}`,
      });
      headers.append(
        "set-cookie",
        `${APP_SIGN_IN}=; Path=/api/v1/sign-in/google; Max-Age=0`
      );
      return new Response(null, { status: 303, headers });
    },
  ],
];

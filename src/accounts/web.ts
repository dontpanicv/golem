import { type Route, withCookies } from "../app/http.ts";
import { form, html, page, toastOf } from "../app/web.ts";
import { authPage } from "./pages.ts";

/** Sign in with Google and sign out, in the web app. */
export const accountWebRoutes: readonly Route[] = [
  ["GET", "/login", async ({ request }) => html(authPage(toastOf(request)))],
  [
    "POST",
    "/login",
    form(async ({ app }) => {
      const google = await app.auth.api.signInSocial({
        body: { provider: "google", callbackURL: "/" },
        returnHeaders: true,
      });
      return withCookies(google, google.response.url!);
    }, "/login"),
  ],
  [
    "POST",
    "/logout",
    page(async ({ app, request }) =>
      withCookies(
        await app.auth.api.signOut({
          headers: request.headers,
          returnHeaders: true,
        }),
        "/login"
      )
    ),
  ],
];

import { type Route, withCookies } from "../app/http.ts";
import { form, html, page, toastOf } from "../app/web.ts";
import { authPage } from "./pages.ts";

/** Sign in with Google and sign out, in the web app. */
export const accountWebRoutes: readonly Route[] = [
  [
    "GET",
    "/login",
    async ({ request }) =>
      html(
        authPage(
          toastOf(request),
          localPath(new URL(request.url).searchParams.get("next"))
        )
      ),
  ],
  [
    "POST",
    "/login",
    form(async ({ app, fields }) => {
      const google = await app.auth.api.signInSocial({
        body: {
          provider: "google",
          callbackURL: localPath(fields.next) ?? "/",
        },
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

/** A path on this site, so that sign-in never sends anyone to another site. */
function localPath(path: string | null | undefined): string | null {
  return path?.startsWith("/") && !path.startsWith("//") && !path.includes("\\")
    ? path
    : null;
}

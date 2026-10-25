import type { Route } from "./app/http.ts";

/** The JSON API for the iOS app. See docs/api.md. */
export const apiRoutes: readonly Route[] = [
  // The iOS app opens these in a browser sheet: Google sign-in, then `golem://signed-in` with a token or an error.
  // Any app can claim `golem://`, so only a sign-in started here hands over a token, and Google always asks.
];

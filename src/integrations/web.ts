import type { Route, RouteInput } from "../app/http.ts";
import { action, withNotice } from "../app/web.ts";

/** Integration credentials on the workspace settings page. */
export const integrationWebRoutes: readonly Route[] = [
  [
    "POST",
    "/w/:workspace/integrations/:integration/credentials",
    action(settingsOf, async ({ app, user, params, fields }) => {
      app.integrations.addCredential(
        params.workspace!,
        user,
        params.integration!,
        { label: fields.label!, secret: fields.secret! }
      );
      return withNotice(settingsOf({ params }), "Credential added");
    }),
  ],
  [
    "POST",
    "/w/:workspace/credentials/:credential/delete",
    action(settingsOf, async ({ app, user, params }) => {
      app.integrations.deleteCredential(
        params.workspace!,
        user,
        params.credential!
      );
      return withNotice(settingsOf({ params }), "Credential deleted");
    }),
  ],
];

function settingsOf({ params }: { params: RouteInput["params"] }): string {
  return `/w/${params.workspace}/settings`;
}

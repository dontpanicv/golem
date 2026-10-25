import type { Route, RouteInput } from "../app/http.ts";
import { action, withNotice } from "../app/web.ts";

/** Integration switches and credentials on the workspace settings page. */
export const integrationWebRoutes: readonly Route[] = [
  [
    "POST",
    "/w/:workspace/integrations/:integration",
    action(settingsOf, async ({ app, user, params, fields }) => {
      app.integrations.setEnabled(
        params.workspace!,
        user,
        params.integration!,
        fields.enabled === "true"
      );
      return settingsOf({ params });
    }),
  ],
  [
    "POST",
    "/w/:workspace/integrations/:integration/credentials",
    action(settingsOf, async ({ app, user, params, fields }) => {
      app.integrations.addCredential(
        params.workspace!,
        user,
        params.integration!,
        {
          label: fields.label!,
          secret: fields.secret!,
          shared: fields.shared === "true",
        }
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

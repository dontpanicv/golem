import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import type { Route, RouteInput } from "../app/http.ts";
import { action, page, withNotice } from "../app/web.ts";
import { machinesSection } from "./pages.ts";

/** The machines section of the workspace settings page: pairing, its live refresh, and removing a machine. */
export const handsWebRoutes: readonly Route[] = [
  [
    "GET",
    "/w/:workspace/machines",
    page(async ({ app, user, params }) => {
      const section = machinesSection(
        params.workspace!,
        app.hands.machines(params.workspace!, user),
        app.hands.pairing(params.workspace!, user)
      );
      return ServerSentEventGenerator.stream((stream) => {
        stream.patchElements(section);
      });
    }),
  ],
  [
    "POST",
    "/w/:workspace/machines/pairing",
    action(settingsOf, async ({ app, user, params }) => {
      await app.hands.startPairing(params.workspace!, user);
      return settingsOf({ params });
    }),
  ],
  [
    "POST",
    "/w/:workspace/machines/:machine/delete",
    action(settingsOf, async ({ app, user, params }) => {
      app.hands.removeMachine(params.workspace!, user, params.machine!);
      return withNotice(settingsOf({ params }), "Machine removed");
    }),
  ],
];

function settingsOf({ params }: { params: RouteInput["params"] }): string {
  return `/w/${params.workspace}/settings`;
}

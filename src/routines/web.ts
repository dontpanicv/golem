import type { Route, RouteInput } from "../app/http.ts";
import { action, html, page, withNotice } from "../app/web.ts";
import { HttpError } from "../platform/errors.ts";
import { shellContext } from "../workspaces/shell.ts";
import { channelDetailsPage } from "./pages.ts";

/** The channel details page, and the switches and actions of its routines. */
export const routineWebRoutes: readonly Route[] = [
  [
    "GET",
    "/w/:workspace/c/:channel/details",
    page(async (input) => {
      const { app, user, params } = input;
      const context = shellContext(input, { channelId: params.channel });
      const channel = context.channels!.find(
        (candidate) => candidate.id === params.channel
      );
      if (!channel) {
        throw new HttpError(404, "Not found");
      }
      const { routines, runs } = app.routines.inChannel(
        params.workspace!,
        channel.id,
        user
      );
      const brief = await app.threads.brief(
        params.workspace!,
        channel.id,
        user
      );
      return html(channelDetailsPage(context, channel, brief, routines, runs));
    }),
  ],
  [
    "POST",
    "/w/:workspace/c/:channel/routines/:routine",
    action(detailsOf, async ({ app, user, params, fields }) => {
      app.routines.setEnabled(params.routine!, user, fields.enabled === "true");
      return detailsOf({ params });
    }),
  ],
  [
    "POST",
    "/w/:workspace/c/:channel/routines/:routine/run",
    action(detailsOf, async ({ app, user, params }) => {
      const routine = app.routines.get(params.routine!, user);
      app.routines.runNow(routine.id, user);
      return withNotice(detailsOf({ params }), `${routine.name} runs now`);
    }),
  ],
  [
    "POST",
    "/w/:workspace/c/:channel/routines/:routine/delete",
    action(detailsOf, async ({ app, user, params }) => {
      const routine = app.routines.get(params.routine!, user);
      app.routines.delete(routine.id, user);
      return withNotice(detailsOf({ params }), `${routine.name} deleted`);
    }),
  ],
];

function detailsOf({ params }: { params: RouteInput["params"] }): string {
  return `/w/${params.workspace}/c/${params.channel}/details`;
}

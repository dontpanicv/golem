import type { Route, RouteInput } from "../app/http.ts";
import {
  action,
  html,
  page,
  redirect,
  toastOf,
  withNotice,
} from "../app/web.ts";
import { HttpError } from "../platform/errors.ts";
import { channelPage, newWorkspacePage } from "./pages.ts";
import { shellContext } from "./shell.ts";

/** Workspaces, their channels, and their members in the web app. */
export const workspaceWebRoutes: readonly Route[] = [
  [
    "GET",
    "/",
    page(async ({ app, user }) => {
      const [first] = app.workspaces.list(user);
      return redirect(first ? `/w/${first.id}` : "/workspaces/new");
    }),
  ],
  [
    "GET",
    "/workspaces/new",
    page(async ({ app, user, request }) =>
      html(
        newWorkspacePage({
          user,
          workspaces: app.workspaces.list(user),
          toast: toastOf(request),
        })
      )
    ),
  ],
  [
    "POST",
    "/workspaces",
    action(
      "/workspaces/new",
      async ({ app, user, fields }) =>
        `/w/${(await app.workspaces.create(user, fields.name!)).id}`
    ),
  ],
  [
    "GET",
    "/w/:workspace",
    page(async ({ app, user, params }) => {
      const [first] = app.workspaces.channels(params.workspace!, user);
      return redirect(
        first
          ? `/w/${params.workspace}/c/${first.id}`
          : `/w/${params.workspace}/settings`
      );
    }),
  ],
  [
    "POST",
    "/w/:workspace/channels",
    action(
      ({ params }) => `/w/${params.workspace}`,
      async ({ app, user, params, fields }) =>
        `/w/${params.workspace}/c/${app.workspaces.createChannel(params.workspace!, user, fields.name!).id}`
    ),
  ],
  [
    "GET",
    "/w/:workspace/c/:channel",
    page(async (input) => {
      const context = shellContext(input, { channelId: input.params.channel });
      const channel = context.channels!.find(
        (candidate) => candidate.id === input.params.channel
      );
      if (!channel) {
        throw new HttpError(404, "Not found");
      }
      return html(channelPage(context, channel));
    }),
  ],
  [
    "POST",
    "/w/:workspace/members",
    action(settingsOf, async ({ app, user, params, fields }) => {
      const member = await app.workspaces.addMember(
        params.workspace!,
        user,
        fields.email!
      );
      return withNotice(
        settingsOf({ params }),
        `${member.name} joined the workspace`
      );
    }),
  ],
];

function settingsOf({ params }: { params: RouteInput["params"] }): string {
  return `/w/${params.workspace}/settings`;
}

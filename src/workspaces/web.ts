import type { AuthedInput, Route, RouteInput } from "../app/http.ts";
import {
  action,
  html,
  page,
  redirect,
  toastOf,
  withNotice,
} from "../app/web.ts";
import { newWorkspacePage } from "./pages.ts";
import { lastOpened } from "./shell.ts";

/** Workspaces, their channels, and their members in the web app. */
export const workspaceWebRoutes: readonly Route[] = [
  [
    "GET",
    "/",
    page(async (input) => {
      const workspaces = input.app.workspaces.list(input.user);
      const last = lastOpened(input.request);
      const workspace =
        workspaces.find((candidate) => candidate.id === last?.workspaceId) ??
        workspaces[0];
      return redirect(
        workspace ? homeOf(input, workspace.id) : "/workspaces/new"
      );
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
    page(async (input) => redirect(homeOf(input, input.params.workspace!))),
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
    "POST",
    "/w/:workspace/c/:channel/delete",
    action(
      ({ params }) => `/w/${params.workspace}/c/${params.channel}`,
      async ({ app, user, params }) => {
        const deleted = app.workspaces.deleteChannel(
          params.workspace!,
          user,
          params.channel!
        );
        const [first] = app.workspaces.channels(params.workspace!, user);
        return withNotice(
          `/w/${params.workspace}/c/${first!.id}`,
          `Deleted #${deleted.name}`
        );
      }
    ),
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

/** Where a workspace opens: the channel or thread this browser had open last, if it still exists, else the orchestrator. */
function homeOf(
  { app, user, request }: AuthedInput,
  workspaceId: string
): string {
  const channels = app.workspaces.channels(workspaceId, user);
  const last = lastOpened(request);
  if (last?.workspaceId === workspaceId) {
    if (channels.some((channel) => channel.id === last.channelId)) {
      return `/w/${workspaceId}/c/${last.channelId}`;
    }
    if (
      channels.some((channel) =>
        channel.threads.some((thread) => thread.id === last.threadId)
      ) ||
      app.workspaces.orchestratorOf(workspaceId)?.id === last.threadId
    ) {
      return `/w/${workspaceId}/t/${last.threadId}`;
    }
  }
  return channels.length > 0
    ? `/w/${workspaceId}/orchestrator`
    : `/w/${workspaceId}/settings`;
}

function settingsOf({ params }: { params: RouteInput["params"] }): string {
  return `/w/${params.workspace}/settings`;
}

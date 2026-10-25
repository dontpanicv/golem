import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import type { Route, RouteInput } from "./app/http.ts";
import {
  action,
  asset,
  html,
  page,
  redirect,
  toastOf,
  withNotice,
} from "./app/web.ts";
import { HttpError } from "./platform/errors.ts";
import { designPage } from "./platform/ui/design.ts";
import {
  channelPage,
  newWorkspacePage,
  settingsPage,
  workspaceSettingsPage,
} from "./ui/pages.ts";
import { searchPage, searchResults } from "./ui/search.ts";
import { shellContext } from "./ui/shell.ts";

/** The web app: HTML from the server, live parts over Datastar. */
export const webRoutes: readonly Route[] = [
  ["GET", "/assets/*", async ({ request }) => asset(request)],
  ["GET", "/design", async () => html(designPage())],

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
    "GET",
    "/w/:workspace/search",
    page(async (input) => {
      const context = shellContext(input, {});
      const query = new URL(input.request.url).searchParams.get("q") ?? "";
      const response = query.trim()
        ? await input.app.indexer.search(context.workspace!.id, query)
        : null;
      return html(searchPage(context, query, response));
    }),
  ],
  [
    "GET",
    "/w/:workspace/search/results",
    page(async (input) => {
      const workspace = input.app.workspaces.get(
        input.params.workspace!,
        input.user
      );
      const signals = await ServerSentEventGenerator.readSignals(input.request);
      const query =
        signals.success && typeof signals.signals.q === "string"
          ? signals.signals.q
          : "";
      const response = query.trim()
        ? await input.app.indexer.search(workspace.id, query)
        : null;
      const results = searchResults(
        workspace.id,
        query,
        response,
        input.app.workspaces.channels(workspace.id, input.user)
      );
      return ServerSentEventGenerator.stream((stream) => {
        stream.patchElements(results);
      });
    }),
  ],
  [
    "GET",
    "/w/:workspace/settings",
    page(async (input) => {
      const { app, user, params } = input;
      const members = app.workspaces.members(params.workspace!, user);
      const integrations = app.integrations.list(params.workspace!, user);
      return html(
        workspaceSettingsPage(shellContext(input, {}), members, integrations)
      );
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
  [
    "GET",
    "/settings",
    page(async ({ app, user, request }) => {
      // Keep the first workspace in the sidebar, so settings feel like part of the app.
      const workspaces = app.workspaces.list(user);
      const [workspace] = workspaces;
      const channels = workspace
        ? app.workspaces.channels(workspace.id, user)
        : undefined;
      return html(
        settingsPage(
          { user, workspaces, workspace, channels, toast: toastOf(request) },
          await app.llm.status()
        )
      );
    }),
  ],
];

function settingsOf({ params }: { params: RouteInput["params"] }): string {
  return `/w/${params.workspace}/settings`;
}

import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import type { AuthedInput, Route, RouteInput } from "./app/http.ts";
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
  threadPage,
  workspaceSettingsPage,
} from "./ui/pages.ts";
import { searchPage, searchResults } from "./ui/search.ts";
import type { ShellContext } from "./ui/shell.ts";
import { transcript } from "./ui/shell.ts";

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
    "POST",
    "/w/:workspace/c/:channel/threads",
    action(
      ({ params }) => `/w/${params.workspace}/c/${params.channel}`,
      async ({ app, user, params, fields }) =>
        `/w/${params.workspace}/t/${(await app.workspaces.createThread(params.workspace!, user, params.channel!, fields.text!)).id}`
    ),
  ],
  [
    "GET",
    "/w/:workspace/t/:thread",
    page(async (input) => {
      const thread = threadIn(input);
      const context = shellContext(input, {
        channelId: thread.channelId,
        threadId: thread.id,
      });
      const channel = context.channels!.find(
        (candidate) => candidate.id === thread.channelId
      )!;
      return html(threadPage(context, channel, thread));
    }),
  ],
  [
    "GET",
    "/w/:workspace/t/:thread/events",
    page(async (input) => {
      const thread = threadIn(input);
      let stop: (() => Promise<void>) | undefined;
      return ServerSentEventGenerator.stream(
        async (stream) => {
          stop = await input.app.threads.watch(thread, (state) => {
            stream.patchElements(transcript(state));
          });
        },
        {
          keepalive: true,
          onAbort: () => {
            stop?.();
          },
        }
      );
    }),
  ],
  [
    "POST",
    "/w/:workspace/t/:thread/messages",
    page(async (input) => {
      const thread = threadIn(input);
      const signals = await ServerSentEventGenerator.readSignals(input.request);
      const text = signals.success ? signals.signals.message : undefined;
      if (typeof text !== "string" || !text.trim()) {
        return new Response(null, { status: 400 });
      }
      await input.app.workspaces.send(thread.id, input.user, text);
      return ServerSentEventGenerator.stream((stream) => {
        stream.patchSignals(JSON.stringify({ message: "" }));
      });
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
      const integrations = app.workspaces.integrations(params.workspace!, user);
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
    "POST",
    "/w/:workspace/integrations/:integration",
    action(settingsOf, async ({ app, user, params, fields }) => {
      app.workspaces.setEnabled(
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
      app.workspaces.addCredential(
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
      app.workspaces.deleteCredential(
        params.workspace!,
        user,
        params.credential!
      );
      return withNotice(settingsOf({ params }), "Credential deleted");
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

function shellContext(
  input: AuthedInput,
  current: ShellContext["current"]
): ShellContext {
  const { app, user, params } = input;
  const workspace = app.workspaces.get(params.workspace!, user);
  return {
    user,
    workspaces: app.workspaces.list(user),
    workspace,
    channels: app.workspaces.channels(workspace.id, user),
    current,
    toast: toastOf(input.request),
  };
}

function threadIn(input: AuthedInput) {
  const thread = input.app.workspaces.thread(input.params.thread!, input.user);
  if (thread.workspaceId !== input.params.workspace) {
    throw new HttpError(404, "Not found");
  }
  return thread;
}

function settingsOf({ params }: { params: RouteInput["params"] }): string {
  return `/w/${params.workspace}/settings`;
}

import { api, eventStream } from "./app/api.ts";
import { json, type Route } from "./app/http.ts";

/** The JSON API for the iOS app. See docs/api.md. */
export const apiRoutes: readonly Route[] = [
  // The iOS app opens these in a browser sheet: Google sign-in, then `golem://signed-in` with a token or an error.
  // Any app can claim `golem://`, so only a sign-in started here hands over a token, and Google always asks.
  [
    "GET",
    "/api/v1/me",
    api(async ({ app, user }) =>
      json({ user, workspaces: app.workspaces.list(user) })
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces",
    api(async ({ app, user, body }) =>
      json(await app.workspaces.create(user, body.name as string))
    ),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace",
    api(async ({ app, user, params }) =>
      json({
        workspace: app.workspaces.get(params.workspace!, user),
        channels: app.workspaces.channels(params.workspace!, user),
      })
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/channels",
    api(async ({ app, user, params, body }) =>
      json(
        app.workspaces.createChannel(
          params.workspace!,
          user,
          body.name as string
        )
      )
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/threads",
    api(async ({ app, user, params, body }) =>
      json(
        await app.workspaces.createThread(
          params.workspace!,
          user,
          body.channelId as string,
          body.text as string
        )
      )
    ),
  ],
  [
    "GET",
    "/api/v1/threads/:thread",
    api(async ({ app, user, params }) => {
      const thread = app.workspaces.thread(params.thread!, user);
      return json({
        thread: summary(thread),
        ...(await app.threads.messages(thread)),
      });
    }),
  ],
  [
    "GET",
    "/api/v1/threads/:thread/events",
    api(async ({ app, user, params }) => {
      const thread = app.workspaces.thread(params.thread!, user);
      return eventStream((send) =>
        app.threads.watch(thread, (state) =>
          send("thread", { thread: summary(thread), ...state })
        )
      );
    }),
  ],
  [
    "POST",
    "/api/v1/threads/:thread/messages",
    api(async ({ app, user, params, body }) => {
      await app.workspaces.send(params.thread!, user, body.text as string);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/search",
    api(async ({ app, user, params, request }) => {
      // Membership first: a workspace's index is only ever searched by its members.
      const workspace = app.workspaces.get(params.workspace!, user);
      const url = new URL(request.url);
      const limit = Math.min(
        Math.max(Number(url.searchParams.get("limit")) || 20, 1),
        50
      );
      return json(
        await app.indexer.search(
          workspace.id,
          url.searchParams.get("q") ?? "",
          limit
        )
      );
    }),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/members",
    api(async ({ app, user, params }) =>
      json(app.workspaces.members(params.workspace!, user))
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/members",
    api(async ({ app, user, params, body }) =>
      json(
        await app.workspaces.addMember(
          params.workspace!,
          user,
          body.email as string
        )
      )
    ),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/integrations",
    api(async ({ app, user, params }) =>
      json(app.workspaces.integrations(params.workspace!, user))
    ),
  ],
  [
    "PUT",
    "/api/v1/workspaces/:workspace/integrations/:integration",
    api(async ({ app, user, params, body }) =>
      json(
        app.workspaces.setEnabled(
          params.workspace!,
          user,
          params.integration!,
          body.enabled === true
        )
      )
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/integrations/:integration/credentials",
    api(async ({ app, user, params, body }) =>
      json(
        app.workspaces.addCredential(
          params.workspace!,
          user,
          params.integration!,
          {
            label: body.label as string,
            secret: body.secret as string,
            shared: body.shared === true,
          }
        )
      )
    ),
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace/credentials/:credential",
    api(async ({ app, user, params }) => {
      app.workspaces.deleteCredential(
        params.workspace!,
        user,
        params.credential!
      );
      return new Response(null, { status: 204 });
    }),
  ],
  ["GET", "/api/v1/llm", api(async ({ app }) => json(await app.llm.status()))],
  [
    "POST",
    "/api/v1/llm/login",
    api(async ({ app }) => json(await app.llm.startLogin())),
  ],
  [
    "POST",
    "/api/v1/llm/logout",
    api(async ({ app }) => json(await app.llm.logout())),
  ],
  [
    "PUT",
    "/api/v1/llm/model",
    api(async ({ app, body }) => {
      app.llm.setModel(body.model as string);
      return json(await app.llm.status());
    }),
  ],
  [
    "PUT",
    "/api/v1/llm/effort",
    api(async ({ app, body }) => {
      app.llm.setEffort(body.effort as string);
      return json(await app.llm.status());
    }),
  ],
];

function summary(thread: {
  id: string;
  channelId: string;
  title: string;
  updatedAt: number;
}) {
  return {
    id: thread.id,
    channelId: thread.channelId,
    title: thread.title,
    updatedAt: thread.updatedAt,
  };
}

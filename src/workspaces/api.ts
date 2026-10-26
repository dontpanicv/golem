import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** Workspaces, their channels, and their members for the iOS app. */
export const workspaceApiRoutes: readonly Route[] = [
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
        workspace: app.workspaces.requireMember(params.workspace!, user),
        channels: app.workspaces.channels(params.workspace!, user),
      })
    ),
  ],
  [
    "PUT",
    "/api/v1/workspaces/:workspace",
    api(async ({ app, user, params, body }) =>
      json(app.workspaces.rename(params.workspace!, user, body.name as string))
    ),
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace",
    api(async ({ app, user, params }) => {
      app.workspaces.delete(params.workspace!, user);
      return new Response(null, { status: 204 });
    }),
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
    "DELETE",
    "/api/v1/workspaces/:workspace/channels/:channel",
    api(async ({ app, user, params }) => {
      app.workspaces.deleteChannel(params.workspace!, user, params.channel!);
      return new Response(null, { status: 204 });
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
];

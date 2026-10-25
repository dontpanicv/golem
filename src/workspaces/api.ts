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

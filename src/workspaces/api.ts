import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** Workspaces, their channels, and their members for the iOS app. */
export const workspaceApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/me",
    api(async ({ app, user }) => {
      // Golem has one workspace; the first person to sign in starts it.
      if (app.workspaces.ids().length === 0) {
        await app.workspaces.create(user, "Golem");
      }
      return json({ user, workspaces: app.workspaces.list(user) });
    }),
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
    "POST",
    "/api/v1/workspaces/:workspace/channels",
    api(async ({ app, user, params, body }) =>
      json(
        app.workspaces.createChannel(
          params.workspace!,
          user,
          body.name as string,
          body.private === true
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
    "/api/v1/workspaces/:workspace/facts",
    api(async ({ app, user, params }) =>
      json(app.workspaces.facts(params.workspace!, user))
    ),
  ],
  [
    "PUT",
    "/api/v1/workspaces/:workspace/facts",
    api(async ({ app, user, params, body }) =>
      json(
        app.workspaces.setFacts(params.workspace!, user, body.text as string)
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

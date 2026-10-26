import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/** The inbox of a workspace, and the devices that get its pushes. Opening a thread marks its notifications read. */
export const notificationApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/notifications",
    api(async ({ app, user, params }) =>
      json(app.notifications.inbox(params.workspace!, user))
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/notifications/read",
    api(async ({ app, user, params, body }) => {
      if (body.id !== undefined && typeof body.id !== "string") {
        throw new HttpError(400, "Id must be text");
      }
      return json(
        app.notifications.read(params.workspace!, user, body.id ?? null)
      );
    }),
  ],
  [
    "POST",
    "/api/v1/devices",
    api(async ({ app, user, body }) => {
      app.notifications.addDevice(user, body.token, body.environment);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "DELETE",
    "/api/v1/devices/:token",
    api(async ({ app, user, params }) => {
      app.notifications.removeDevice(user, params.token!);
      return new Response(null, { status: 204 });
    }),
  ],
];

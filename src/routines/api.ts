import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** The routines of a topic. Agents create and change them; people pause, run, and delete them. */
export const routineApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/topics/:topic/routines",
    api(async ({ app, user, params }) =>
      json(app.routines.inTopic(params.workspace!, params.topic!, user))
    ),
  ],
  [
    "PUT",
    "/api/v1/routines/:routine",
    api(async ({ app, user, params, body }) =>
      json(
        app.routines.setEnabled(params.routine!, user, body.enabled === true)
      )
    ),
  ],
  [
    "POST",
    "/api/v1/routines/:routine/runs",
    api(async ({ app, user, params }) => {
      app.routines.runNow(params.routine!, user);
      return new Response(null, { status: 202 });
    }),
  ],
  [
    "DELETE",
    "/api/v1/routines/:routine",
    api(async ({ app, user, params }) => {
      app.routines.delete(params.routine!, user);
      return new Response(null, { status: 204 });
    }),
  ],
];

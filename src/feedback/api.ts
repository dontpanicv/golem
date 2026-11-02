import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** The reports that agents write about Golem, for the server's owner. */
export const feedbackApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/feedback",
    api(async ({ app, user, params }) =>
      json({ feedback: app.feedback.list(params.workspace!, user) })
    ),
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace/feedback/:feedback",
    api(async ({ app, user, params }) => {
      app.feedback.dismiss(params.workspace!, user, params.feedback!);
      return new Response(null, { status: 204 });
    }),
  ],
];

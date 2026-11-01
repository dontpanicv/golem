import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/**
 * Each person's agenda: what Golem runs for them, what waits for them, and the automations Golem suggests; and the
 * reports of their iPhone that they arrived at or left the place of a reminder.
 */
export const agendaApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/upcoming",
    api(async ({ app, user, params }) =>
      json(app.agenda.upcoming(params.workspace!, user))
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/suggestions/:suggestion",
    api(async ({ app, user, params, body }) => {
      if (typeof body.accept !== "boolean") {
        throw new HttpError(400, "Send accept as true or false");
      }
      await app.agenda.answer(
        params.workspace!,
        user,
        params.suggestion!,
        body.accept
      );
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/reminders/:reminder/trigger",
    api(async ({ app, user, params }) =>
      json(app.reminders.trigger(params.workspace!, user, params.reminder!))
    ),
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace/reminders/:reminder",
    api(async ({ app, user, params }) => {
      app.agenda.cancelReminder(params.workspace!, user, params.reminder!);
      return new Response(null, { status: 204 });
    }),
  ],
];

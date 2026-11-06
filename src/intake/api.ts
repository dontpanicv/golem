import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/** Private evidence and corrections use the same service as the agent tools. */
export const intakeApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/intake",
    api(async ({ app, params, user, request }) =>
      json(
        app.intake.status(
          params.workspace!,
          user,
          new URL(request.url).searchParams.get("q") ?? ""
        )
      )
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/intake/checks/:check",
    api(async ({ app, params, user, body }) => {
      if (
        typeof body.resolved !== "boolean" ||
        typeof body.quote !== "string" ||
        !(body.at === undefined || typeof body.at === "string")
      ) {
        throw new HttpError(
          400,
          "Send resolved, the correction as quote, and optionally an ISO time as at"
        );
      }
      app.intake.updateCheck(params.workspace!, user, params.check!, {
        resolved: body.resolved,
        quote: body.quote,
        at: body.at,
      });
      return json({ updated: true });
    }),
  ],
];

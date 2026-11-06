import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/** Private evidence and corrections use the same service as the agent tools. */
export const intakeApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/following",
    api(async ({ app, params, user }) =>
      json({ checks: app.intake.following.list(params.workspace!, user) })
    ),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/following/:check",
    api(async ({ app, params, user }) =>
      json(app.intake.following.detail(params.workspace!, user, params.check!))
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/following/:check",
    api(async ({ app, params, user, body }) => {
      if (
        !(
          typeof body.action === "string" &&
          ["handled", "stop", "reopen", "correct", "undo"].includes(
            body.action
          ) &&
          Number.isSafeInteger(body.revision) &&
          typeof body.quote === "string"
        )
      ) {
        throw new HttpError(400, "Send action, revision, and quote");
      }
      return json(
        await app.intake.following.change(
          params.workspace!,
          user,
          params.check!,
          {
            action: body.action as
              | "handled"
              | "stop"
              | "reopen"
              | "correct"
              | "undo",
            revision: body.revision as number,
            quote: body.quote,
          }
        )
      );
    }),
  ],

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
];

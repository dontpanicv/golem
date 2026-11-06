import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/** Private evidence and corrections use the same service as the agent tools. */
export const intakeApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/following/overview",
    api(async ({ app, params, user, request }) =>
      json(
        app.intake.following.overview(
          params.workspace!,
          user,
          new URL(request.url).searchParams.get("q") ?? ""
        )
      )
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/following/feedback",
    api(async ({ app, params, user, body }) => {
      if (
        !(typeof body.target === "string" && typeof body.quote === "string")
      ) {
        throw new HttpError(400, "Send target and quote");
      }
      return json(
        app.intake.following.feedback(
          params.workspace!,
          user,
          body.target,
          body.quote
        )
      );
    }),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/following/updates/:update",
    api(async ({ app, params, user, body }) => {
      if (!(body.action === "now" || body.action === "cancel")) {
        throw new HttpError(400, "Send action now or cancel");
      }
      return json(
        app.intake.following.changeUpdate(
          params.workspace!,
          user,
          params.update!,
          body.action
        )
      );
    }),
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace/following/updates/:update",
    api(async ({ app, params, user }) => {
      await app.intake.deleteUpdate(params.workspace!, user, params.update!);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace/following/blocks/:block",
    api(async ({ app, params, user }) => {
      app.intake.following.unblock(params.workspace!, user, params.block!);
      return new Response(null, { status: 204 });
    }),
  ],
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

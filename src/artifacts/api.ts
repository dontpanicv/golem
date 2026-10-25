import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/**
 * The artifacts of a thread for the iOS app. Agents make and change them; people open them, change who sees them,
 * and delete them or their data. The app runs an artifact's `content` in a web view whose `golem` calls go to `rpc`.
 */
export const artifactApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/threads/:thread/artifacts",
    api(async ({ app, user, params }) =>
      json({ artifacts: app.artifacts.inThread(params.thread!, user) })
    ),
  ],
  [
    "GET",
    "/api/v1/artifacts/:artifact",
    api(async ({ app, user, params }) => {
      const artifact = app.artifacts.get(params.artifact!, user);
      return json({
        artifact,
        records: app.artifacts.dataFor(artifact.id, user),
        content: app.artifacts.content(artifact.id),
      });
    }),
  ],
  [
    "PUT",
    "/api/v1/artifacts/:artifact",
    api(async ({ app, user, params, body }) =>
      json(app.artifacts.setVisibility(params.artifact!, user, body.visibility))
    ),
  ],
  [
    "DELETE",
    "/api/v1/artifacts/:artifact",
    api(async ({ app, user, params }) => {
      app.artifacts.delete(params.artifact!, user);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "POST",
    "/api/v1/artifacts/:artifact/rpc",
    api(async ({ app, user, params, body }) =>
      json({
        result: app.artifacts.call(
          params.artifact!,
          { user },
          body.op,
          body.args
        ),
      })
    ),
  ],
  [
    "DELETE",
    "/api/v1/artifacts/:artifact/data",
    api(async ({ app, user, params }) => {
      app.artifacts.clearData(params.artifact!, user);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "DELETE",
    "/api/v1/artifacts/:artifact/records/:record",
    api(async ({ app, user, params }) => {
      app.artifacts.deleteRecordFor(params.artifact!, user, params.record!);
      return new Response(null, { status: 204 });
    }),
  ],
];

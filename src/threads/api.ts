import { api, eventStream } from "../app/api.ts";
import { fileResponse, json, type Route } from "../app/http.ts";

/** Threads and their files for the iOS app. Messages and files post as JSON, or as a multipart form with files. */
export const threadApiRoutes: readonly Route[] = [
  [
    "POST",
    "/api/v1/workspaces/:workspace/threads",
    api(async ({ app, user, params, body, files }) =>
      json(
        await app.threads.create(
          params.workspace!,
          user,
          body.channelId as string,
          body.text as string | undefined,
          files
        )
      )
    ),
  ],
  [
    "GET",
    "/api/v1/threads/:thread",
    api(async ({ app, user, params }) => {
      const thread = app.workspaces.thread(params.thread!, user);
      return json({
        thread: summary(thread),
        ...(await app.threads.messages(thread)),
      });
    }),
  ],
  [
    "GET",
    "/api/v1/threads/:thread/events",
    api(async ({ app, user, params }) => {
      const thread = app.workspaces.thread(params.thread!, user);
      return eventStream((send) =>
        app.threads.watch(thread, (state) =>
          send("thread", { thread: summary(thread), ...state })
        )
      );
    }),
  ],
  [
    "POST",
    "/api/v1/threads/:thread/messages",
    api(async ({ app, user, params, body, files }) => {
      await app.threads.send(
        params.thread!,
        user,
        body.text as string | undefined,
        files,
        body.voice === true || body.voice === "true"
      );
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/threads/:thread/files",
    api(async ({ app, user, params }) =>
      json({
        files: await app.threads.files(
          app.workspaces.thread(params.thread!, user)
        ),
      })
    ),
  ],
  [
    "POST",
    "/api/v1/threads/:thread/files",
    api(async ({ app, user, params, files }) =>
      json({ files: await app.threads.upload(params.thread!, user, files) })
    ),
  ],
  [
    "GET",
    "/api/v1/threads/:thread/files/:file",
    api(async ({ app, user, params }) => {
      const { path, name } = await app.threads.file(
        app.workspaces.thread(params.thread!, user),
        params.file!
      );
      return fileResponse(path, name);
    }),
  ],
  [
    "DELETE",
    "/api/v1/threads/:thread/files/:file",
    api(async ({ app, user, params }) =>
      json({
        files: await app.threads.deleteFile(params.thread!, user, params.file!),
      })
    ),
  ],
];

function summary(thread: {
  id: string;
  channelId: string;
  title: string;
  updatedAt: number;
}) {
  return {
    id: thread.id,
    channelId: thread.channelId,
    title: thread.title,
    updatedAt: thread.updatedAt,
  };
}

import { api, eventStream } from "../app/api.ts";
import { fileResponse, json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/** Threads, and the files of channels and of the workspace, for the iOS app. Messages and files post as JSON, or as a multipart form with files. */
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
    "/api/v1/workspaces/:workspace/orchestrator",
    api(async ({ app, user, params }) =>
      json(summary(await app.threads.orchestrator(params.workspace!, user)))
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
    "POST",
    "/api/v1/workspaces/:workspace/threads/:thread/settled",
    api(async ({ app, user, params, body }) => {
      if (typeof body.settled !== "boolean") {
        throw new HttpError(400, "Settled must be true or false");
      }
      return json(
        app.workspaces.setThreadSettled(
          params.workspace!,
          params.thread!,
          user,
          body.settled
        )
      );
    }),
  ],
  [
    "GET",
    "/api/v1/threads/:thread/events",
    api(async ({ app, user, params }) => {
      const thread = app.workspaces.thread(params.thread!, user);
      return eventStream(
        async (send) => {
          const stop = await app.threads.watch(thread, (state) =>
            send("thread", { thread: summary(thread), ...state })
          );
          // While a screen follows the thread, its person sees what happens there and gets no notification for it.
          const unwatch = app.notifications.watch(user, thread.id);
          return async () => {
            unwatch();
            await stop();
          };
        },
        () => app.workspaces.thread(params.thread!, user)
      );
    }),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/working",
    api(async ({ app, user, params }) => {
      // A non-member gets 404 before the stream starts.
      app.workspaces.requireMember(params.workspace!, user);
      return eventStream(
        (send) =>
          app.threads.watchWorking(params.workspace!, user, (threadIds) =>
            send("working", { threadIds })
          ),
        () => app.workspaces.requireMember(params.workspace!, user)
      );
    }),
  ],
  [
    "POST",
    "/api/v1/threads/:thread/stop",
    api(async ({ app, user, params }) => {
      await app.threads.stop(params.thread!, user);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "POST",
    "/api/v1/threads/:thread/approvals/:approval",
    api(async ({ app, user, params, body }) => {
      if (
        typeof body.allow !== "boolean" ||
        !(body.scope === "once" || body.scope === "turn")
      ) {
        throw new HttpError(
          400,
          'Allow must be true or false, and scope "once" or "turn"'
        );
      }
      app.threads.answerApproval(
        params.thread!,
        params.approval!,
        user,
        body.allow,
        body.scope
      );
      return new Response(null, { status: 204 });
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
        body.voice === true || body.voice === "true",
        typeof body.requestId === "string" ? body.requestId : undefined
      );
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/channels/:channel/files",
    api(async ({ app, user, params }) =>
      json({
        files: await app.threads.files(
          app.threads.place(params.workspace!, params.channel!, user)
        ),
      })
    ),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/channels/:channel/brief",
    api(async ({ app, user, params }) =>
      json({
        brief: await app.threads.brief(
          params.workspace!,
          params.channel!,
          user
        ),
      })
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/channels/:channel/files",
    api(async ({ app, user, params, files }) =>
      json({
        files: await app.threads.upload(
          params.workspace!,
          params.channel!,
          user,
          files
        ),
      })
    ),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/files",
    api(async ({ app, user, params }) =>
      json({
        files: await app.threads.files(
          app.threads.place(params.workspace!, null, user)
        ),
      })
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/files",
    api(async ({ app, user, params, files }) =>
      json({
        files: await app.threads.upload(params.workspace!, null, user, files),
      })
    ),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/files/:file",
    api(async ({ app, user, params }) => {
      const { path, name } = await app.threads.file(
        params.workspace!,
        user,
        params.file!
      );
      return fileResponse(path, name);
    }),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/files/:file/picture",
    api(async ({ app, user, params }) => {
      const jpeg = await app.threads.picture(
        params.workspace!,
        user,
        params.file!
      );
      if (!jpeg) {
        throw new HttpError(404, "No picture");
      }
      return new Response(jpeg, {
        headers: {
          "content-type": "image/jpeg",
          // A changed file keeps its id and address.
          "cache-control": "no-cache",
        },
      });
    }),
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace/files/:file",
    api(async ({ app, user, params }) => {
      const { files } = await app.threads.deleteFile(
        params.workspace!,
        user,
        params.file!
      );
      return json({ files });
    }),
  ],
  [
    "POST",
    "/api/v1/threads/:thread/live-activity",
    api(async ({ app, user, params, body }) => {
      app.threads.followActivity(
        params.thread!,
        user,
        body.token,
        body.environment
      );
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/learned",
    api(async ({ app, user, params }) =>
      json({ learned: app.threads.learnedFor(params.workspace!, user) })
    ),
  ],
  [
    "PUT",
    "/api/v1/workspaces/:workspace/learned/:id",
    api(async ({ app, user, params, body }) =>
      json(
        app.threads.changeLearned(
          params.workspace!,
          user,
          Number(params.id),
          body.text
        )
      )
    ),
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace/learned/:id",
    api(async ({ app, user, params }) => {
      app.threads.removeLearned(params.workspace!, user, Number(params.id));
      return new Response(null, { status: 204 });
    }),
  ],
];

function summary(thread: {
  id: string;
  channelId: string;
  title: string;
  updatedAt: number;
  settledAt: number | null;
}) {
  return {
    id: thread.id,
    channelId: thread.channelId,
    title: thread.title,
    updatedAt: thread.updatedAt,
    settledAt: thread.settledAt,
  };
}

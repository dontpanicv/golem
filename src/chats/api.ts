import { api, eventStream } from "../app/api.ts";
import { fileResponse, json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/** Chats, and the files of topics and of the workspace, for the iOS app. Messages and files post as JSON, or as a multipart form with files. */
export const chatApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/chats",
    api(async ({ app, user, params, request }) => {
      const query = new URL(request.url).searchParams;
      return json({
        chats: app.chats.list(params.workspace!, user, {
          topic: query.get("topic") ?? undefined,
          since: query.get("since") ?? undefined,
          before: query.get("before") ?? undefined,
          order: (query.get("order") ?? undefined) as
            | "newest"
            | "oldest"
            | undefined,
        }),
      });
    }),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/chats",
    api(async ({ app, user, params, body, files }) =>
      json(
        await app.chats.create(
          params.workspace!,
          user,
          body.topicId as string,
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
      json(summary(await app.chats.orchestrator(params.workspace!, user)))
    ),
  ],
  [
    "GET",
    "/api/v1/chats/:chat",
    api(async ({ app, user, params }) => {
      const chat = app.workspaces.chat(params.chat!, user);
      return json({
        chat: summary(chat),
        ...(await app.chats.messages(chat)),
      });
    }),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/chats/:chat/settled",
    api(async ({ app, user, params, body }) => {
      if (typeof body.settled !== "boolean") {
        throw new HttpError(400, "Settled must be true or false");
      }
      return json(
        app.workspaces.setChatSettled(
          params.workspace!,
          params.chat!,
          user,
          body.settled
        )
      );
    }),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/chats/:chat/topic",
    api(async ({ app, user, params, body }) => {
      if (typeof body.topicId !== "string") {
        throw new HttpError(400, "Choose a topic");
      }
      return json(
        summary(
          await app.chats.move(
            params.workspace!,
            user,
            params.chat!,
            body.topicId
          )
        )
      );
    }),
  ],
  [
    "GET",
    "/api/v1/chats/:chat/events",
    api(async ({ app, user, params }) => {
      const chat = app.workspaces.chat(params.chat!, user);
      return eventStream(
        async (send) => {
          const stop = await app.chats.watch(chat, (state) => {
            // The chat as it is now, such as in the topic it moved to; nothing once the person no longer sees it.
            const current = app.workspaces
              .chatsIn(chat.workspaceId, user.id)
              .find((candidate) => candidate.id === chat.id);
            if (current) {
              send("chat", { chat: summary(current), ...state });
            }
          });
          // While a screen follows the chat, its person sees what happens there and gets no notification for it.
          const unwatch = app.notifications.watch(user, chat.id);
          return async () => {
            unwatch();
            await stop();
          };
        },
        () => app.workspaces.chat(params.chat!, user)
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
          app.chats.watchWorking(params.workspace!, user, (chatIds) =>
            send("working", { chatIds })
          ),
        () => app.workspaces.requireMember(params.workspace!, user)
      );
    }),
  ],
  [
    "POST",
    "/api/v1/chats/:chat/stop",
    api(async ({ app, user, params }) => {
      await app.chats.stop(params.chat!, user);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "POST",
    "/api/v1/chats/:chat/approvals/:approval",
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
      app.chats.answerApproval(
        params.chat!,
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
    "/api/v1/chats/:chat/messages",
    api(async ({ app, user, params, body, files }) => {
      await app.chats.send(
        params.chat!,
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
    "/api/v1/workspaces/:workspace/topics/:topic/files",
    api(async ({ app, user, params }) =>
      json({
        files: await app.chats.files(
          app.chats.place(params.workspace!, params.topic!, user)
        ),
      })
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/topics/:topic/merge",
    api(async ({ app, user, params, body }) => {
      if (typeof body.into !== "string") {
        throw new HttpError(400, "Choose a topic");
      }
      await app.chats.merge(params.workspace!, user, params.topic!, body.into);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/topics/:topic/brief",
    api(async ({ app, user, params }) =>
      json({
        brief: await app.chats.brief(params.workspace!, params.topic!, user),
      })
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/topics/:topic/files",
    api(async ({ app, user, params, files }) =>
      json({
        files: await app.chats.upload(
          params.workspace!,
          params.topic!,
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
        files: await app.chats.files(
          app.chats.place(params.workspace!, null, user)
        ),
      })
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/files",
    api(async ({ app, user, params, files }) =>
      json({
        files: await app.chats.upload(params.workspace!, null, user, files),
      })
    ),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/files/:file",
    api(async ({ app, user, params }) => {
      const { path, name } = await app.chats.file(
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
      const jpeg = await app.chats.picture(
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
      const { files } = await app.chats.deleteFile(
        params.workspace!,
        user,
        params.file!
      );
      return json({ files });
    }),
  ],
  [
    "POST",
    "/api/v1/chats/:chat/live-activity",
    api(async ({ app, user, params, body }) => {
      app.chats.followActivity(
        params.chat!,
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
      json({ learned: app.chats.learnedFor(params.workspace!, user) })
    ),
  ],
  [
    "PUT",
    "/api/v1/workspaces/:workspace/learned/:id",
    api(async ({ app, user, params, body }) =>
      json(
        app.chats.changeLearned(
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
      app.chats.removeLearned(params.workspace!, user, Number(params.id));
      return new Response(null, { status: 204 });
    }),
  ],
];

function summary(chat: {
  id: string;
  topicId: string;
  title: string;
  updatedAt: number;
  settledAt: number | null;
}) {
  return {
    id: chat.id,
    topicId: chat.topicId,
    title: chat.title,
    updatedAt: chat.updatedAt,
    settledAt: chat.settledAt,
  };
}

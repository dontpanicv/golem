import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import { type AuthedInput, fileResponse, type Route } from "../app/http.ts";
import { action, html, page, readForm, rejectCrossOrigin } from "../app/web.ts";
import { threadArtifacts } from "../artifacts/pages.ts";
import { HttpError } from "../platform/errors.ts";
import { rememberOpened, shellContext } from "../workspaces/shell.ts";
import { threadFiles, threadPage, transcript } from "./pages.ts";

/** A thread: its page, its live transcript and files, and new messages and files. */
export const threadWebRoutes: readonly Route[] = [
  [
    "POST",
    "/w/:workspace/c/:channel/threads",
    action(
      ({ params }) => `/w/${params.workspace}/c/${params.channel}`,
      async ({ app, user, params, fields, files }) =>
        `/w/${params.workspace}/t/${(await app.threads.create(params.workspace!, user, params.channel!, fields.text, files)).id}`
    ),
  ],
  [
    "GET",
    "/w/:workspace/t/:thread",
    page(async (input) => {
      const thread = threadIn(input);
      const context = shellContext(input, {
        channelId: thread.channelId,
        threadId: thread.id,
      });
      const channel = context.channels!.find(
        (candidate) => candidate.id === thread.channelId
      )!;
      return rememberOpened(
        input.request,
        html(
          threadPage(
            context,
            channel,
            thread,
            await input.app.threads.files(thread),
            input.app.artifacts.inThread(thread.id, input.user)
          )
        )
      );
    }),
  ],
  [
    "POST",
    "/w/:workspace/t/:thread/settled",
    action(
      ({ params }) => `/w/${params.workspace}/t/${params.thread}`,
      async ({ app, user, params, fields }) => {
        if (fields.settled !== "true" && fields.settled !== "false") {
          throw new HttpError(400, "Settled must be true or false");
        }
        const thread = app.workspaces.setThreadSettled(
          params.workspace!,
          params.thread!,
          user,
          fields.settled === "true"
        );
        return `/w/${params.workspace}/c/${thread.channelId}`;
      }
    ),
  ],
  [
    "GET",
    "/w/:workspace/t/:thread/events",
    page(async (input) => {
      const thread = threadIn(input);
      let stop: (() => Promise<void>) | undefined;
      let open = true;
      // Files and artifacts come with messages, so each change also lists them again, one listing after another.
      let files = Promise.resolve();
      return ServerSentEventGenerator.stream(
        async (stream) => {
          stop = await input.app.threads.watch(thread, (state) => {
            stream.patchElements(transcript(state, thread));
            files = files.then(async () => {
              const listed = await input.app.threads.files(thread);
              // The page may close while the folder is read.
              if (open) {
                stream.patchElements(
                  threadFiles(thread.workspaceId, thread.id, listed)
                );
                stream.patchElements(
                  threadArtifacts(
                    thread.workspaceId,
                    thread.id,
                    input.app.artifacts.inThread(thread.id, input.user)
                  )
                );
              }
            });
          });
        },
        {
          keepalive: true,
          onAbort: () => {
            open = false;
            stop?.();
          },
        }
      );
    }),
  ],
  [
    "POST",
    "/w/:workspace/t/:thread/messages",
    page(async (input) => {
      rejectCrossOrigin(input);
      const thread = threadIn(input);
      const { fields, files } = await readForm(input.request);
      await input.app.threads.send(thread.id, input.user, fields.text, files);
      return ServerSentEventGenerator.stream((stream) => {
        stream.executeScript("document.getElementById('composer').reset()");
      });
    }),
  ],
  [
    "POST",
    "/w/:workspace/t/:thread/files",
    page(async (input) => {
      rejectCrossOrigin(input);
      const thread = threadIn(input);
      const { files } = await readForm(input.request);
      const all = await input.app.threads.upload(thread.id, input.user, files);
      return ServerSentEventGenerator.stream((stream) => {
        stream.patchElements(threadFiles(thread.workspaceId, thread.id, all));
      });
    }),
  ],
  [
    "DELETE",
    "/w/:workspace/t/:thread/files/:file",
    page(async (input) => {
      rejectCrossOrigin(input);
      const thread = threadIn(input);
      const left = await input.app.threads.deleteFile(
        thread.id,
        input.user,
        input.params.file!
      );
      return ServerSentEventGenerator.stream((stream) => {
        stream.patchElements(threadFiles(thread.workspaceId, thread.id, left));
      });
    }),
  ],
  [
    "GET",
    "/w/:workspace/t/:thread/files/:file",
    page(async (input) => {
      const { path, name } = await input.app.threads.file(
        threadIn(input),
        input.params.file!
      );
      return fileResponse(path, name);
    }),
  ],
];

function threadIn(input: AuthedInput) {
  const thread = input.app.workspaces.thread(input.params.thread!, input.user);
  if (thread.workspaceId !== input.params.workspace) {
    throw new HttpError(404, "Not found");
  }
  return thread;
}

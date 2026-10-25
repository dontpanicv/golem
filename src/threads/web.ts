import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import type { AuthedInput, Route } from "../app/http.ts";
import { action, html, page } from "../app/web.ts";
import { HttpError } from "../platform/errors.ts";
import { rememberOpened, shellContext } from "../workspaces/shell.ts";
import { threadPage, transcript } from "./pages.ts";

/** A thread: its page, its live transcript, and new messages. */
export const threadWebRoutes: readonly Route[] = [
  [
    "POST",
    "/w/:workspace/c/:channel/threads",
    action(
      ({ params }) => `/w/${params.workspace}/c/${params.channel}`,
      async ({ app, user, params, fields }) =>
        `/w/${params.workspace}/t/${(await app.threads.create(params.workspace!, user, params.channel!, fields.text!)).id}`
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
        html(threadPage(context, channel, thread))
      );
    }),
  ],
  [
    "GET",
    "/w/:workspace/t/:thread/events",
    page(async (input) => {
      const thread = threadIn(input);
      let stop: (() => Promise<void>) | undefined;
      return ServerSentEventGenerator.stream(
        async (stream) => {
          stop = await input.app.threads.watch(thread, (state) => {
            stream.patchElements(transcript(state, thread.workspaceId));
          });
        },
        {
          keepalive: true,
          onAbort: () => {
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
      const thread = threadIn(input);
      const signals = await ServerSentEventGenerator.readSignals(input.request);
      const text = signals.success ? signals.signals.message : undefined;
      if (typeof text !== "string" || !text.trim()) {
        return new Response(null, { status: 400 });
      }
      await input.app.threads.send(thread.id, input.user, text);
      return ServerSentEventGenerator.stream((stream) => {
        stream.patchSignals(JSON.stringify({ message: "" }));
      });
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

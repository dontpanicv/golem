import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import { type AuthedInput, fileResponse, type Route } from "../app/http.ts";
import {
  action,
  html,
  page,
  readForm,
  redirect,
  rejectCrossOrigin,
} from "../app/web.ts";
import { artifactList } from "../artifacts/pages.ts";
import { HttpError } from "../platform/errors.ts";
import { workingKey } from "../platform/ui/components.ts";
import {
  rememberOpened,
  type ShellContext,
  shellContext,
  sidebarContent,
} from "../workspaces/shell.ts";
import {
  channelPage,
  fileList,
  type PlacePanel,
  threadPage,
  transcript,
} from "./pages.ts";
import type { FilePlace } from "./threads.ts";

/**
 * Channels and threads: a channel's page, a thread's page and live transcript, new threads and messages, and the files
 * of channels and of the workspace.
 */
export const threadWebRoutes: readonly Route[] = [
  [
    "GET",
    "/w/:workspace/c/:channel",
    page(async (input) => {
      const { params, request } = input;
      const context = shellContext(input, { channelId: params.channel });
      const channel = context.channels!.find(
        (candidate) => candidate.id === params.channel
      );
      if (!channel) {
        throw new HttpError(404, "Not found");
      }
      const panel = await placePanel(input, {
        workspaceId: params.workspace!,
        channelId: channel.id,
      });
      return rememberOpened(
        request,
        html(channelPage(context, channel, panel))
      );
    }),
  ],
  [
    "POST",
    "/w/:workspace/c/:channel/files",
    page((input) => upload(input, input.params.channel!)),
  ],
  ["POST", "/w/:workspace/files", page((input) => upload(input, null))],
  [
    "DELETE",
    "/w/:workspace/files/:file",
    page(async (input) => {
      rejectCrossOrigin(input);
      const { place, files } = await input.app.threads.deleteFile(
        input.params.workspace!,
        input.user,
        input.params.file!
      );
      return ServerSentEventGenerator.stream((stream) => {
        stream.patchElements(fileList(place, files));
      });
    }),
  ],
  [
    "GET",
    "/w/:workspace/files/:file",
    page(async ({ app, user, params }) => {
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
    "/w/:workspace/orchestrator",
    page(async ({ app, user, params, request }) =>
      redirect(
        // A search result opens one of the workspace's own artifacts here.
        `/w/${params.workspace}/t/${(await app.threads.orchestrator(params.workspace!, user)).id}${new URL(request.url).search}`
      )
    ),
  ],
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
      const panel = await placePanel(input, input.app.threads.placeOf(thread));
      return rememberOpened(
        input.request,
        html(threadPage(context, channel, thread, panel))
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
      const place = input.app.threads.placeOf(thread);
      let stop: (() => Promise<void>) | undefined;
      let open = true;
      // Files and artifacts come with messages, so each change also lists them again, one listing after another.
      let files = Promise.resolve();
      return ServerSentEventGenerator.stream(
        async (stream) => {
          stop = await input.app.threads.watch(thread, (state) => {
            stream.patchElements(transcript(state, thread));
            stream.patchSignals(JSON.stringify({ running: state.running }));
            files = files.then(async () => {
              const listed = await input.app.threads.files(place);
              // The page may close while the folder is read.
              if (open) {
                stream.patchElements(fileList(place, listed));
                stream.patchElements(
                  artifactList(
                    thread.workspaceId,
                    input.app.artifacts.inPlace(
                      thread.workspaceId,
                      place.channelId,
                      input.user
                    )
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
    "/w/:workspace/t/:thread/stop",
    page(async (input) => {
      rejectCrossOrigin(input);
      await input.app.threads.stop(threadIn(input).id, input.user);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/w/:workspace/working",
    page(async (input) => {
      // A non-member gets 404 before the stream starts.
      input.app.workspaces.requireMember(input.params.workspace!, input.user);
      const current = pageOf(new URL(input.request.url).searchParams);
      let stop: (() => Promise<void>) | undefined;
      let shown: readonly string[] = [];
      let content = "";
      return ServerSentEventGenerator.stream(
        async (stream) => {
          stop = await input.app.threads.watchWorking(
            input.params.workspace!,
            input.user,
            (threadIds) => {
              // A removed key does not hide its spinner, so a thread that stopped working gets false.
              const working = Object.fromEntries([
                ...shown.map((id) => [workingKey(id), false]),
                ...threadIds.map((id) => [workingKey(id), true]),
              ]);
              shown = threadIds;
              stream.patchSignals(JSON.stringify({ working }));
              // Agents start threads and channels as they work, so the sidebar shows them when work starts or ends.
              const next = sidebarContent(shellContext(input, current));
              if (next !== content) {
                content = next;
                stream.patchElements(next);
              }
            }
          );
        },
        { keepalive: true, onAbort: () => stop?.() }
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
];

/** The page a sidebar is on, as its working stream's query gives it, so the sidebar marks it. */
function pageOf(query: URLSearchParams): ShellContext["current"] {
  const name = query.get("page");
  return {
    channelId: query.get("channelId") ?? undefined,
    threadId: query.get("threadId") ?? undefined,
    page:
      name === "workspace-settings" || name === "settings" || name === "search"
        ? name
        : undefined,
  };
}

function threadIn(input: AuthedInput) {
  const thread = input.app.workspaces.thread(input.params.thread!, input.user);
  if (thread.workspaceId !== input.params.workspace) {
    throw new HttpError(404, "Not found");
  }
  return thread;
}

/** The files and artifacts of a place, with the artifact of `?artifact=` open. */
async function placePanel(
  { app, user, request }: AuthedInput,
  place: FilePlace
): Promise<PlacePanel> {
  const artifacts = app.artifacts.inPlace(
    place.workspaceId,
    place.channelId,
    user
  );
  const openId = new URL(request.url).searchParams.get("artifact");
  const artifact = artifacts.find((candidate) => candidate.id === openId);
  return {
    place,
    files: await app.threads.files(place),
    artifacts,
    open: artifact
      ? { artifact, records: app.artifacts.dataFor(artifact.id, user) }
      : null,
  };
}

/** Uploads files to a channel, or to the workspace's own files for a null `channelId`. */
async function upload(input: AuthedInput, channelId: string | null) {
  rejectCrossOrigin(input);
  const workspaceId = input.params.workspace!;
  const { files } = await readForm(input.request);
  const all = await input.app.threads.upload(
    workspaceId,
    channelId,
    input.user,
    files
  );
  return ServerSentEventGenerator.stream((stream) => {
    stream.patchElements(fileList({ workspaceId, channelId }, all));
  });
}

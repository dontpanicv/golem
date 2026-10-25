import type { Artifact } from "../artifacts/artifacts.ts";
import { artifactPreview, threadArtifacts } from "../artifacts/pages.ts";
import { button, composer, empty, message } from "../platform/ui/components.ts";
import { icon } from "../platform/ui/icons.ts";
import { type ShellContext, shell } from "../workspaces/shell.ts";
import type { Channel, ThreadSummary } from "../workspaces/workspaces.ts";
import type { Message, ThreadFile, ThreadMessages } from "./threads.ts";

const escapeHtml = Bun.escapeHTML;

export function threadPage(
  context: ShellContext,
  channel: Channel,
  thread: ThreadSummary,
  files: readonly ThreadFile[],
  artifacts: readonly Artifact[]
): string {
  const base = `/w/${context.workspace!.id}/t/${thread.id}`;
  // The orchestrator belongs to the workspace, not to its channel, and stays open.
  const orchestrator = thread.id === context.orchestratorId;
  return shell(context, {
    title: thread.title,
    header: orchestrator
      ? escapeHtml(thread.title)
      : `<span class="breadcrumb">${escapeHtml(channel.name)} › </span>${escapeHtml(thread.title)}`,
    headerActions: orchestrator
      ? ""
      : `<form method="post" action="${base}/settled"><input type="hidden" name="settled" value="${thread.settledAt === null}">${button(thread.settledAt === null ? "Settle thread" : "Un-settle thread", { variant: "ghost", icon: thread.settledAt === null ? "check" : "inbox", size: "icon", attributes: 'type="submit"' })}</form>`,
    main: `<section id="transcript" class="transcript" aria-live="polite"></section>
			${composer(orchestrator ? "Message Golem" : `Message #${channel.name}`, `@post('${base}/messages', {contentType: 'form'})`)}`,
    artifacts: {
      artifacts: threadArtifacts(context.workspace!.id, thread.id, artifacts),
      files: threadFiles(context.workspace!.id, thread.id, files),
      preview: artifactPreview(context.workspace!.id, thread.id, null),
    },
    signals: "artifactData: false",
    init: `@get('${base}/events')`,
  });
}

/** The transcript element that the thread's event stream patches after every change. */
export function transcript(
  state: ThreadMessages,
  thread: { readonly id: string; readonly workspaceId: string }
): string {
  const items = state.messages
    .map((m: Message) =>
      message(
        m,
        (threadId) => `/w/${thread.workspaceId}/t/${threadId}`,
        (fileId) => fileHref(thread.workspaceId, thread.id, fileId)
      )
    )
    .join("");
  const working =
    state.running && !state.messages.some((m) => m.streaming)
      ? '<p class="working">Golem is working…</p>'
      : "";
  const nothing =
    items === "" && !working
      ? '<div class="empty"><strong>Ask Golem anything</strong></div>'
      : "";
  return `<section id="transcript" class="transcript" aria-live="polite">${items}${working}${nothing}</section>`;
}

/**
 * The Files tab of a thread: an upload button and the thread's files, newest first, each with a delete button. Files
 * dropped on the tab upload. Uploads, deletes, and the event stream patch it.
 */
export function threadFiles(
  workspaceId: string,
  threadId: string,
  files: readonly ThreadFile[]
): string {
  const rows = files
    .toReversed()
    .map((file) => {
      const href = fileHref(workspaceId, threadId, file.id);
      return `<div class="file-row"><a class="list-row" href="${href}" target="_blank">${icon("file")}<span class="name">${escapeHtml(file.name)}</span><span class="meta">${size(file.size)}</span></a>${button(`Delete ${file.name}`, { variant: "ghost", icon: "trash", size: "icon", attributes: `type="button" data-on:click="@delete('${href}')"` })}</div>`;
    })
    .join("");
  return `<div id="thread-files" class="thread-files" data-file-drop data-show="$tab === 'files'" style="display: none">
		<form enctype="multipart/form-data" data-on:change="@post('/w/${workspaceId}/t/${threadId}/files', {contentType: 'form'})">
			${button("Upload files", { icon: "plus", attributes: 'type="button" data-file-pick' })}
			<input type="file" name="files" multiple hidden>
		</form>
		${rows ? `<div class="list">${rows}</div>` : empty("file", "No files yet")}
	</div>`;
}

function fileHref(workspaceId: string, threadId: string, fileId: string) {
  return `/w/${workspaceId}/t/${threadId}/files/${fileId}`;
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

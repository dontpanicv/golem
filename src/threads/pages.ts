import type { Artifact, ArtifactRecord } from "../artifacts/artifacts.ts";
import { artifactList, artifactPreview } from "../artifacts/pages.ts";
import {
  button,
  composer,
  dialog,
  empty,
  message,
  workingSpinner,
} from "../platform/ui/components.ts";
import { icon } from "../platform/ui/icons.ts";
import { type ShellContext, shell } from "../workspaces/shell.ts";
import type { Channel, ThreadSummary } from "../workspaces/workspaces.ts";
import type {
  FilePlace,
  Message,
  SavedFile,
  ThreadMessages,
} from "./threads.ts";

const escapeHtml = Bun.escapeHTML;

/**
 * What the side panel shows: the files and artifacts of a place, and `open`, an artifact to show in the preview at
 * once, as a search result opens it.
 */
export interface PlacePanel {
  readonly place: FilePlace;
  readonly files: readonly SavedFile[];
  readonly artifacts: readonly Artifact[];
  readonly open: {
    readonly artifact: Artifact;
    readonly records: readonly ArtifactRecord[];
  } | null;
}

export function threadPage(
  context: ShellContext,
  channel: Channel,
  thread: ThreadSummary,
  panel: PlacePanel
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
			${composer(orchestrator ? "Message Golem" : `Message #${channel.name}`, `@post('${base}/messages', {contentType: 'form'})`, `@post('${base}/stop')`)}`,
    artifacts: placeTabs(panel),
    signals: `${placeSignals(panel)}, running: false`,
    init: `@get('${base}/events')`,
  });
}

/** A channel: its threads, settled ones folded away, and the panel with its files and artifacts. */
export function channelPage(
  context: ShellContext,
  channel: Channel,
  panel: PlacePanel
): string {
  const workspaceId = context.workspace!.id;
  const active = channel.threads.filter((thread) => thread.settledAt === null);
  const settled = channel.threads
    .filter((thread) => thread.settledAt !== null)
    .sort((left, right) => right.settledAt! - left.settledAt!);
  const threads = channel.threads.length
    ? `<div class="list">${active.map((thread) => threadRow(workspaceId, thread)).join("")}
      ${settled.length ? `<details class="settled-threads"><summary>Settled (${settled.length})</summary>${settled.map((thread) => threadRow(workspaceId, thread)).join("")}</details>` : ""}</div>`
    : empty("compose", "No threads yet");
  return shell(context, {
    title: `#${channel.name}`,
    header: `<span class="breadcrumb"># </span>${escapeHtml(channel.name)}`,
    headerActions: `<a class="button ghost icon-only" href="/w/${workspaceId}/c/${channel.id}/details" aria-label="Channel details" data-tooltip="Channel details">${icon("info")}</a>${button("Delete channel", { variant: "ghost", icon: "trash", size: "icon", attributes: 'type="button" data-dialog-open="delete-channel"' })}`,
    main: `<div class="transcript">${threads}</div>
			${composer(`Start a thread in #${channel.name}`, { post: `/w/${workspaceId}/c/${channel.id}/threads` })}
			${dialog("delete-channel", { title: `Delete #${channel.name}?`, action: `/w/${workspaceId}/c/${channel.id}/delete`, submit: "Delete channel", body: "<p>Its threads, files, artifacts, and routines go with it.</p>" })}`,
    artifacts: placeTabs(panel),
    signals: placeSignals(panel),
  });
}

function placeTabs({ place, files, artifacts, open }: PlacePanel) {
  return {
    artifacts: artifactList(place.workspaceId, artifacts),
    files: fileList(place, files),
    preview: artifactPreview(
      place.workspaceId,
      open?.artifact ?? null,
      open?.records
    ),
  };
}

/** An artifact to open shows the panel on its Preview tab. */
function placeSignals({ open }: PlacePanel): string {
  return open
    ? "artifactData: false, artifacts: true, tab: 'preview'"
    : "artifactData: false";
}

function threadRow(workspaceId: string, thread: ThreadSummary): string {
  const time = new Date(thread.updatedAt).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const settled = thread.settledAt !== null;
  return `<div class="file-row"><a class="list-row" href="/w/${workspaceId}/t/${thread.id}">${icon("compose")}<span class="name">${escapeHtml(thread.title)}</span>${workingSpinner(thread.id)}<span class="meta">${time}</span></a><form method="post" action="/w/${workspaceId}/t/${thread.id}/settled"><input type="hidden" name="settled" value="${!settled}">${button(settled ? "Un-settle thread" : "Settle thread", { variant: "ghost", icon: settled ? "inbox" : "check", size: "icon", attributes: 'type="submit"' })}</form></div>`;
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
        (fileId) => fileHref(thread.workspaceId, fileId)
      )
    )
    .join("");
  const nothing =
    items === ""
      ? '<div class="empty"><strong>Ask Golem anything</strong></div>'
      : "";
  return `<section id="transcript" class="transcript" aria-live="polite">${items}${nothing}</section>`;
}

/**
 * The Files tab of a place: an upload button and its files, newest first, each with a delete button. Files dropped on
 * the tab upload. Uploads, deletes, and a thread's event stream patch it.
 */
export function fileList(
  place: FilePlace,
  files: readonly SavedFile[]
): string {
  const { workspaceId, channelId } = place;
  const upload =
    channelId === null
      ? `/w/${workspaceId}/files`
      : `/w/${workspaceId}/c/${channelId}/files`;
  const rows = files
    .toReversed()
    .map((file) => {
      const href = fileHref(workspaceId, file.id);
      return `<div class="file-row"><a class="list-row" href="${href}" target="_blank">${icon("file")}<span class="name">${escapeHtml(file.name)}</span><span class="meta">${size(file.size)}</span></a>${button(`Delete ${file.name}`, { variant: "ghost", icon: "trash", size: "icon", attributes: `type="button" data-on:click="@delete('${href}')"` })}</div>`;
    })
    .join("");
  return `<div id="file-list" class="thread-files" data-file-drop data-show="$tab === 'files'" style="display: none">
		<form enctype="multipart/form-data" data-on:change="@post('${upload}', {contentType: 'form'})">
			${button("Upload files", { icon: "plus", attributes: 'type="button" data-file-pick' })}
			<input type="file" name="files" multiple hidden>
		</form>
		${rows ? `<div class="list">${rows}</div>` : empty("file", "No files yet")}
	</div>`;
}

/** A file opens by its id alone, wherever in the workspace it is. */
function fileHref(workspaceId: string, fileId: string) {
  return `/w/${workspaceId}/files/${fileId}`;
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

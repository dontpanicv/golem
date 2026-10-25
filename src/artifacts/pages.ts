import {
  badge,
  button,
  empty,
  menu,
  settingsCard,
  settingsRow,
} from "../platform/ui/components.ts";
import { icon } from "../platform/ui/icons.ts";
import type { Artifact, ArtifactRecord } from "./artifacts.ts";

const escapeHtml = Bun.escapeHTML;

/**
 * The page a link opens: the artifact in a sandboxed frame, which reaches Golem only through `/assets/artifact.js`.
 * Link previews, such as WhatsApp's, show its title.
 */
export function artifactPage(artifact: Artifact): string {
  const title = escapeHtml(artifact.title);
  return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
	<title>${title}</title>
	<meta property="og:title" content="${title}">
	<meta property="og:site_name" content="Golem">
	<meta property="og:type" content="website">
	<link rel="icon" href="/assets/icon.png" type="image/png">
	<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
	<style>html, body { height: 100%; margin: 0; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
	<script src="/assets/artifact.js" defer></script>
</head>
<body>
<iframe src="/a/${artifact.id}/content?v=${artifact.updatedAt}" title="${title}" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" allow="fullscreen; clipboard-write; autoplay" data-rpc="/a/${artifact.id}/rpc"></iframe>
</body>
</html>`;
}

/** The Artifacts tab of a thread: its artifacts, newest first. A click opens one in the Preview tab. */
export function threadArtifacts(
  workspaceId: string,
  threadId: string,
  artifacts: readonly Artifact[]
): string {
  const rows = artifacts
    .map(
      (artifact) =>
        `<button type="button" class="list-row" data-on:click="@get('${artifactBase(workspaceId, threadId, artifact.id)}')">${icon("artifact")}<span class="name">${escapeHtml(artifact.title)}</span><span class="meta">${visitors(artifact.visitors)}</span></button>`
    )
    .join("");
  return `<div id="thread-artifacts" class="thread-files" data-show="$tab === 'artifacts'">
		${rows ? `<div class="list">${rows}</div>` : empty("artifact", "No artifacts yet")}
	</div>`;
}

/** The Preview tab: the open artifact running, or the data it keeps, with its actions. */
export function artifactPreview(
  workspaceId: string,
  threadId: string,
  artifact: Artifact | null,
  records: readonly ArtifactRecord[] = []
): string {
  if (!artifact) {
    return `<div id="artifact-preview" class="artifact-preview" data-show="$tab === 'preview'" style="display: none">${empty("preview", "Nothing to preview")}</div>`;
  }
  const base = artifactBase(workspaceId, threadId, artifact.id);
  const isPublic = artifact.visibility === "public";
  const actions = menu(
    button(`${artifact.title} actions`, {
      variant: "ghost",
      icon: "more",
      size: "icon",
      attributes:
        'type="button" data-popover-trigger aria-haspopup="menu" aria-expanded="false"',
    }),
    [
      {
        kind: "action",
        label: "Open",
        icon: "preview",
        attributes: `type="button" data-on:click="window.open('/a/${artifact.id}', '_blank')"`,
      },
      {
        kind: "action",
        label: "Copy link",
        icon: "link",
        attributes: `type="button" data-copy="${escapeHtml(artifact.url)}"`,
      },
      {
        kind: "action",
        label: isPublic ? "Make members only" : "Make public",
        icon: isPublic ? "lock" : "preview",
        attributes: `type="button" data-on:click="@post('${base}/visibility/${isPublic ? "members" : "public"}')"`,
      },
      { kind: "separator" },
      {
        kind: "action",
        label: "Clear data",
        icon: "inbox",
        attributes: `type="button" data-on:click="@delete('${base}/data')"`,
      },
      {
        kind: "action",
        label: "Delete",
        icon: "trash",
        attributes: `type="button" data-on:click="@delete('${base}')"`,
      },
    ]
  );
  const data = records.length
    ? settingsCard(records.map((record) => recordRow(base, record)))
    : empty("inbox", "No data yet");
  return `<div id="artifact-preview" class="artifact-preview" data-show="$tab === 'preview'" style="display: none">
		<div class="artifact-bar">
			<strong class="artifact-title">${escapeHtml(artifact.title)}</strong>
			${badge(isPublic ? "Public" : "Members", isPublic ? "accent" : undefined)}
			${button("Data", { variant: "ghost", size: "small", attributes: `type="button" data-on:click="$artifactData = !$artifactData" data-attr:aria-pressed="$artifactData ? 'true' : 'false'"` })}
			${actions}
		</div>
		<iframe class="artifact-frame" src="/a/${artifact.id}?v=${artifact.updatedAt}" title="${escapeHtml(artifact.title)}" data-show="!$artifactData"></iframe>
		<div class="artifact-data" data-show="$artifactData" style="display: none">${data}</div>
	</div>`;
}

function recordRow(base: string, record: ArtifactRecord): string {
  const who = record.visitor ? (record.name ?? "Visitor") : "Shared";
  return settingsRow(
    record.key,
    `${who} · ${JSON.stringify(record.value).slice(0, 200)}`,
    button(`Delete ${record.key}`, {
      variant: "ghost",
      icon: "trash",
      size: "icon",
      attributes: `type="button" data-on:click="@delete('${base}/records/${record.id}')"`,
    }),
    { compact: true }
  );
}

function artifactBase(workspaceId: string, threadId: string, id: string) {
  return `/w/${workspaceId}/t/${threadId}/artifacts/${id}`;
}

function visitors(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

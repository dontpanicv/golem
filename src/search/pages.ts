import { empty } from "../platform/ui/components.ts";
import { type IconName, icon } from "../platform/ui/icons.ts";
import { type ShellContext, shell } from "../workspaces/shell.ts";
import type { Channel } from "../workspaces/workspaces.ts";
import type { SearchResponse } from "./indexer.ts";
import type { Modality, SearchKind } from "./workspace-index.ts";

const escapeHtml = Bun.escapeHTML;
const KIND_ICONS: Record<SearchKind, IconName> = {
  thread: "compose",
  note: "file",
  file: "file",
  capture: "inbox",
};
const MEDIA_ICONS: Partial<Record<Modality, IconName>> = {
  image: "photo",
  audio: "sound",
};

/** Search across one workspace: results update as you type. */
export function searchPage(
  context: ShellContext,
  query: string,
  response: SearchResponse | null
): string {
  const workspaceId = context.workspace!.id;
  const main = `<div class="page"><div class="page-content search">
		<label class="search-box">${icon("search")}<input class="input large" type="search" name="q" value="${escapeHtml(query)}" placeholder="Search ${escapeHtml(context.workspace!.name)}" aria-label="Search" autocomplete="off" autofocus
			data-bind:q data-on:input__debounce.200ms="@get('/w/${workspaceId}/search/results')"></label>
		${searchResults(workspaceId, query, response, context.channels ?? [])}
	</div></div>`;
  return shell(
    { ...context, current: { page: "search" } },
    {
      title: "Search",
      main,
      signals: `q: '${escapeHtml(query.replace(/'/g, "\\'"))}'`,
    }
  );
}

/** The `#results` element that the live search patches. */
export function searchResults(
  workspaceId: string,
  query: string,
  response: SearchResponse | null,
  channels: readonly Channel[]
): string {
  if (!(query.trim() && response)) {
    return '<div id="results" class="search-results"></div>';
  }
  const names = new Map(channels.map((channel) => [channel.id, channel.name]));
  const rows = response.results
    .map((result) => {
      const when = new Date(result.updatedAt).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      });
      const place = result.channelId
        ? `#${names.get(result.channelId) ?? "channel"} · ${when}`
        : when;
      const symbol = MEDIA_ICONS[result.modality] ?? KIND_ICONS[result.kind];
      const body = `${icon(symbol)}<span class="search-text"><strong>${escapeHtml(result.title)}</strong><span>${escapeHtml(result.snippet)}</span></span><span class="meta">${escapeHtml(place)}</span>`;
      return result.threadId && result.kind === "thread"
        ? `<a class="list-row search-row" href="/w/${workspaceId}/t/${result.threadId}">${body}</a>`
        : `<div class="list-row search-row">${body}</div>`;
    })
    .join("");
  const mode = response.semantic
    ? ""
    : '<p class="muted search-mode">Matching words only while the search model starts.</p>';
  return `<div id="results" class="search-results">${mode}${rows || empty("search", "Nothing found")}</div>`;
}

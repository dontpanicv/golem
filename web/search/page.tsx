import { useLiveQuery } from "@tanstack/react-db";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { fileHref, request } from "../app/api.ts";
import type {
  Modality,
  SearchKind,
  SearchResponse,
  SearchResult,
} from "../app/types.ts";
import { Empty } from "../ui/components.tsx";
import { day } from "../ui/format.ts";
import { Icon, type IconName } from "../ui/icon.tsx";
import { channelsOf, useMe } from "../workspaces/data.ts";
import { FloatingSidebarButton } from "../workspaces/shell.tsx";

const KIND_ICONS: Record<SearchKind, IconName> = {
  thread: "compose",
  artifact: "artifact",
  note: "file",
  file: "file",
  capture: "inbox",
};
const MEDIA_ICONS: Partial<Record<Modality, IconName>> = {
  image: "photo",
  audio: "sound",
};

const route = getRouteApi("/signed-in/w/$workspaceId/search");

/** Search across one workspace: results update as you type. */
export function SearchPage() {
  const { workspaceId } = route.useParams();
  const { q = "" } = route.useSearch();
  const navigate = route.useNavigate();
  const [query, setQuery] = useState(q);
  const debounced = useDebouncedValue(query, 200);
  useEffect(() => {
    navigate({ search: { q: debounced || undefined }, replace: true });
  }, [debounced, navigate]);
  const workspace = useMe().workspaces.find(
    (candidate) => candidate.id === workspaceId
  );
  const { data: channels = [] } = useLiveQuery({
    query: (builder) => builder.from({ channel: channelsOf(workspaceId) }),
  });
  const { data: response } = useQuery({
    queryKey: ["workspaces", workspaceId, "search", debounced],
    queryFn: ({ signal }) =>
      request<SearchResponse>(
        `/workspaces/${workspaceId}/search?q=${encodeURIComponent(debounced)}`,
        { signal }
      ),
    enabled: debounced.trim() !== "",
    placeholderData: keepPreviousData,
    gcTime: 0,
  });
  const names = new Map(channels.map((channel) => [channel.id, channel.name]));
  return (
    <section className="conversation">
      <FloatingSidebarButton />
      <div className="page">
        <div className="page-content search">
          <label className="search-box">
            <Icon name="search" />
            <input
              aria-label="Search"
              autoComplete="off"
              autoFocus
              className="input large"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${workspace?.name ?? ""}`}
              type="search"
              value={query}
            />
          </label>
          {query.trim() && response ? (
            <div className="search-results">
              {response.semantic ? null : (
                <p className="muted search-mode">
                  Matching words only while the search model starts.
                </p>
              )}
              {response.results.length > 0 ? (
                response.results.map((result) => (
                  <ResultRow
                    channelName={
                      result.channelId ? names.get(result.channelId) : undefined
                    }
                    key={result.uri}
                    result={result}
                    workspaceId={workspaceId}
                  />
                ))
              ) : (
                <Empty icon="search" title="Nothing found" />
              )}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ResultRow({
  workspaceId,
  result,
  channelName,
}: {
  workspaceId: string;
  result: SearchResult;
  channelName: string | undefined;
}) {
  const when = day(result.updatedAt);
  const place = result.channelId
    ? `#${channelName ?? "channel"} · ${when}`
    : when;
  const body = (
    <>
      <Icon name={MEDIA_ICONS[result.modality] ?? KIND_ICONS[result.kind]} />
      <span className="search-text">
        <strong>{result.title}</strong>
        <span>{result.snippet}</span>
      </span>
      <span className="meta">{place}</span>
    </>
  );
  const target = resultTarget(result);
  if (target.kind === "artifact") {
    // An artifact opens in its channel, or in the orchestrator when it is the workspace's own.
    return target.channelId ? (
      <Link
        className="search-row list-row"
        params={{ workspaceId, channelId: target.channelId }}
        search={{ artifact: target.id }}
        to="/w/$workspaceId/c/$channelId"
      >
        {body}
      </Link>
    ) : (
      <Link
        className="search-row list-row"
        params={{ workspaceId }}
        search={{ artifact: target.id }}
        to="/w/$workspaceId/orchestrator"
      >
        {body}
      </Link>
    );
  }
  if (target.kind === "file") {
    return (
      <a
        className="search-row list-row"
        href={fileHref(workspaceId, target.id)}
        rel="noopener"
        target="_blank"
      >
        {body}
      </a>
    );
  }
  if (target.kind === "thread") {
    return (
      <Link
        className="search-row list-row"
        params={{ workspaceId, threadId: target.id }}
        to="/w/$workspaceId/t/$threadId"
      >
        {body}
      </Link>
    );
  }
  return <div className="search-row list-row">{body}</div>;
}

/** What a result opens: an artifact, a file that Golem saved, a thread, or nothing. */
export function resultTarget(
  result: Pick<SearchResult, "kind" | "uri" | "channelId" | "threadId">
):
  | { kind: "artifact"; id: string; channelId: string | null }
  | { kind: "file" | "thread"; id: string }
  | { kind: "none" } {
  if (result.kind === "artifact") {
    return {
      kind: "artifact",
      id: result.uri.slice("artifact:".length),
      channelId: result.channelId,
    };
  }
  const file = /^(?:channels\/[^/]+\/)?files\/([0-9a-f-]{36})-/.exec(
    result.uri
  );
  if (file) {
    return { kind: "file", id: file[1]! };
  }
  return result.threadId
    ? { kind: "thread", id: result.threadId }
    : { kind: "none" };
}

function useDebouncedValue<Value>(value: Value, milliseconds: number): Value {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), milliseconds);
    return () => clearTimeout(timer);
  }, [value, milliseconds]);
  return settled;
}

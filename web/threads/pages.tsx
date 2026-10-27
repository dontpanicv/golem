import { eq, isNull, not, useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { fileHref } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { ThreadSummary } from "../app/types.ts";
import { ArtifactList, ArtifactPreview } from "../artifacts/panel.tsx";
import {
  Button,
  Dialog,
  Empty,
  Tooltip,
  WorkingSpinner,
} from "../ui/components.tsx";
import { previewLink } from "../ui/file-preview.tsx";
import { dayTime, size } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import {
  channelsOf,
  orchestratorQuery,
  refreshWorkspace,
  rememberOpened,
  setSettled,
  threadsOf,
} from "../workspaces/data.ts";
import { PanelHeader } from "../workspaces/shell.tsx";
import { Composer } from "./composer.tsx";
import {
  filesOf,
  messagesOf,
  type Place,
  placeKey,
  startThread,
  stopThread,
  uploadFiles,
  useThreadStream,
} from "./data.ts";
import { followEnd, MessageView } from "./message.tsx";
import { followed, outbox, sendMessage } from "./outbox.ts";

const threadRoute = getRouteApi("/signed-in/w/$workspaceId/t/$threadId");

/** A thread of the workspace in the address; a thread of another workspace is not found. */
export function ThreadPage() {
  const { workspaceId, threadId } = threadRoute.useParams();
  const orchestrator = useQuery(orchestratorQuery(workspaceId)).data;
  const isOrchestrator = orchestrator?.id === threadId;
  const { data: listed, isReady } = useLiveQuery({
    query: (q) =>
      q
        .from({ thread: threadsOf(workspaceId) })
        .where(({ thread: row }) => eq(row.id, threadId))
        .findOne(),
  });
  const thread = isOrchestrator ? orchestrator : listed;
  if (!thread) {
    return isReady && orchestrator ? (
      <section className="conversation">
        <PanelHeader title="" />
        <Empty icon="hash" title="Not found" />
      </section>
    ) : null;
  }
  return (
    <Thread
      isOrchestrator={isOrchestrator}
      thread={thread}
      threadId={threadId}
      workspaceId={workspaceId}
    />
  );
}

/** A thread: its live transcript and composer, and the panel with its place's artifacts and files. */
function Thread({
  workspaceId,
  threadId,
  thread,
  isOrchestrator,
}: {
  workspaceId: string;
  threadId: string;
  thread: ThreadSummary;
  isOrchestrator: boolean;
}) {
  const { data: channel } = useLiveQuery({
    query: (q) =>
      q
        .from({ channel: channelsOf(workspaceId) })
        .where(({ channel: row }) => eq(row.id, thread.channelId))
        .findOne(),
  });
  const { data: messages = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ message: messagesOf(threadId) })
        .orderBy(({ message }) => message.time),
  });
  // The orchestrator belongs to the workspace, not to its channel: its files and artifacts are the workspace's own.
  const place: Place = {
    workspaceId,
    channelId: isOrchestrator ? null : thread.channelId,
  };
  const key = placeKey(place);
  const placeChanged = useDebounced(
    useCallback(
      () =>
        queryClient.invalidateQueries({
          predicate: ({ queryKey }) => queryKey.includes(key),
        }),
      [key]
    )
  );
  const { data: waiting = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ message: outbox })
        .where(({ message }) => eq(message.threadId, threadId))
        .orderBy(({ message }) => message.time),
  });
  const running = useThreadStream(threadId, placeChanged);
  useEffect(() => {
    followed.add(threadId);
    return () => {
      followed.delete(threadId);
    };
  }, [threadId]);
  useEffect(
    () => rememberOpened(`/w/${workspaceId}/t/${threadId}`),
    [workspaceId, threadId]
  );
  const settled = thread.settledAt !== null;
  return (
    <>
      <section className="conversation">
        <PanelHeader
          title={
            isOrchestrator ? (
              thread.title
            ) : (
              <>
                <span className="breadcrumb">{channel?.name} › </span>
                {thread.title}
              </>
            )
          }
        >
          {isOrchestrator ? null : (
            <Button
              icon={settled ? "inbox" : "check"}
              label={settled ? "Un-settle thread" : "Settle thread"}
              onClick={() => setSettled(workspaceId, threadId, !settled)}
              size="icon"
              variant="ghost"
            />
          )}
          <PanelToggle />
        </PanelHeader>
        <section
          aria-live="polite"
          className="transcript"
          id="transcript"
          ref={followEnd}
        >
          {messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              workspaceId={workspaceId}
            />
          ))}
          {waiting.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              pending
              workspaceId={workspaceId}
            />
          ))}
          {messages.length + waiting.length === 0 ? (
            <div className="empty">
              <strong>Ask Golem anything</strong>
            </div>
          ) : null}
        </section>
        <Composer
          clearAtOnce
          onSend={(text, files) => sendMessage(threadId, text, files)}
          onStop={() => stopThread(threadId).catch(showError)}
          placeholder={
            isOrchestrator ? "Message Golem" : `Message #${channel?.name ?? ""}`
          }
          running={running}
        />
      </section>
      <PlacePanel place={place} />
    </>
  );
}

const channelRoute = getRouteApi("/signed-in/w/$workspaceId/c/$channelId");

/** A channel: its threads, settled ones folded away, and the panel with its files and artifacts. */
export function ChannelPage() {
  const { workspaceId, channelId } = channelRoute.useParams();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const channels = channelsOf(workspaceId);
  const { data: channel, isReady } = useLiveQuery({
    query: (q) =>
      q
        .from({ channel: channels })
        .where(({ channel: row }) => eq(row.id, channelId))
        .findOne(),
  });
  const { data: active = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ thread: threadsOf(workspaceId) })
        .where(({ thread }) => eq(thread.channelId, channelId))
        .where(({ thread }) => isNull(thread.settledAt))
        .orderBy(({ thread }) => thread.updatedAt, "desc"),
  });
  const { data: settled = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ thread: threadsOf(workspaceId) })
        .where(({ thread }) => eq(thread.channelId, channelId))
        .where(({ thread }) => not(isNull(thread.settledAt)))
        .orderBy(({ thread }) => thread.settledAt, "desc"),
  });
  useEffect(
    () => rememberOpened(`/w/${workspaceId}/c/${channelId}`),
    [workspaceId, channelId]
  );
  if (!channel) {
    return isReady ? (
      <section className="conversation">
        <PanelHeader title="" />
        <Empty icon="hash" title="Not found" />
      </section>
    ) : null;
  }
  const remove = () => {
    setDeleting(false);
    const next = [...channels.values()].find((other) => other.id !== channelId);
    const deleted = channels.delete(channelId);
    if (next) {
      navigate({
        to: "/w/$workspaceId/c/$channelId",
        params: { workspaceId, channelId: next.id },
      });
    }
    deleted.isPersisted.promise
      .then(() => refreshWorkspace(workspaceId))
      .catch(showError);
  };
  return (
    <>
      <section className="conversation">
        <PanelHeader
          title={
            <>
              <span className="breadcrumb"># </span>
              {channel.name}
            </>
          }
        >
          <Tooltip label="Channel details">
            <Link
              aria-label="Channel details"
              className="button ghost icon-only"
              params={{ workspaceId, channelId }}
              to="/w/$workspaceId/c/$channelId/details"
            >
              <Icon name="info" />
            </Link>
          </Tooltip>
          <Button
            icon="trash"
            label="Delete channel"
            onClick={() => setDeleting(true)}
            size="icon"
            variant="ghost"
          />
          <PanelToggle />
        </PanelHeader>
        <div className="transcript">
          {active.length + settled.length > 0 ? (
            <div className="list">
              {active.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  workspaceId={workspaceId}
                />
              ))}
              {settled.length > 0 ? (
                <details className="settled-threads">
                  <summary>Settled ({settled.length})</summary>
                  {settled.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      workspaceId={workspaceId}
                    />
                  ))}
                </details>
              ) : null}
            </div>
          ) : (
            <Empty icon="compose" title="No threads yet" />
          )}
        </div>
        <Composer
          onSend={async (text, files) => {
            const thread = await startThread(
              workspaceId,
              channelId,
              text,
              files
            );
            navigate({
              to: "/w/$workspaceId/t/$threadId",
              params: { workspaceId, threadId: thread.id },
            });
          }}
          placeholder={`Start a thread in #${channel.name}`}
        />
        <Dialog
          onClose={() => setDeleting(false)}
          onSubmit={remove}
          open={deleting}
          submit="Delete channel"
          title={`Delete #${channel.name}?`}
        >
          <p>Its threads, files, artifacts, and routines go with it.</p>
        </Dialog>
      </section>
      <PlacePanel place={{ workspaceId, channelId }} />
    </>
  );
}

function ThreadRow({
  workspaceId,
  thread,
}: {
  workspaceId: string;
  thread: {
    id: string;
    title: string;
    updatedAt: number;
    settledAt: number | null;
  };
}) {
  const settled = thread.settledAt !== null;
  return (
    <div className="file-row">
      <Link
        className="list-row"
        params={{ workspaceId, threadId: thread.id }}
        to="/w/$workspaceId/t/$threadId"
      >
        <Icon name="compose" />
        <span className="name">{thread.title}</span>
        <WorkingSpinner threadId={thread.id} />
        <span className="meta">{dayTime(thread.updatedAt)}</span>
      </Link>
      <Button
        icon={settled ? "inbox" : "check"}
        label={settled ? "Un-settle thread" : "Settle thread"}
        onClick={() => setSettled(workspaceId, thread.id, !settled)}
        size="icon"
        variant="ghost"
      />
    </div>
  );
}

/** Whether the side panel shows; wide screens show it at first. A page's header toggles it. */
const panelOpen = {
  value: matchMedia("(min-width: 1001px)").matches,
  listeners: new Set<(open: boolean) => void>(),
  set(open: boolean) {
    this.value = open;
    for (const listener of this.listeners) {
      listener(open);
    }
  },
};

function usePanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(panelOpen.value);
  useEffect(() => {
    panelOpen.listeners.add(setOpen);
    return () => {
      panelOpen.listeners.delete(setOpen);
    };
  }, []);
  return [open, (value) => panelOpen.set(value)];
}

function PanelToggle() {
  const [open, setOpen] = usePanelOpen();
  return (
    <Button
      aria-pressed={open}
      icon="panel"
      label="Artifacts"
      onClick={() => setOpen(!open)}
      size="icon"
      variant="ghost"
    />
  );
}

const placeRoute = getRouteApi("/signed-in/w/$workspaceId");

/**
 * The side panel of a place: its artifacts and files in tabs, and the preview of the artifact that `?artifact=` names,
 * as a list or a search result opens it.
 */
function PlacePanel({ place }: { place: Place }) {
  const [open, setOpen] = usePanelOpen();
  const [tab, setTab] = useState<"artifacts" | "files">("artifacts");
  const { artifact } = placeRoute.useSearch({
    select: (search) => search as { artifact?: string },
  });
  const navigate = useNavigate();
  const key = placeKey(place);
  useEffect(() => {
    if (artifact) {
      panelOpen.set(true);
    }
  }, [artifact]);
  const openArtifact = (artifactId: string | undefined) =>
    navigate({
      to: ".",
      search: (previous) => ({ ...previous, artifact: artifactId }),
    });
  if (!open) {
    return null;
  }
  return (
    <aside aria-label="Artifacts" className="artifacts">
      <header className="panel-header">
        {artifact ? (
          <Button
            label="Close preview"
            onClick={() => openArtifact(undefined)}
            size="small"
            style={{ marginRight: "auto" }}
            variant="ghost"
          />
        ) : (
          <div className="tabs" role="tablist">
            <Tab
              current={tab}
              id="artifacts"
              label="Artifacts"
              onSelect={setTab}
            />
            <Tab current={tab} id="files" label="Files" onSelect={setTab} />
          </div>
        )}
        <Button
          icon="close"
          label="Close artifacts"
          onClick={() => setOpen(false)}
          size="icon"
          variant="ghost"
        />
      </header>
      {artifact ? (
        <ArtifactPreview
          artifactId={artifact}
          onClose={() => openArtifact(undefined)}
          placeKey={key}
          workspaceId={place.workspaceId}
        />
      ) : null}
      {!artifact && tab === "artifacts" ? (
        <ArtifactList onOpen={openArtifact} placeKey={key} />
      ) : null}
      {!artifact && tab === "files" ? <FileList place={place} /> : null}
    </aside>
  );
}

function Tab<Id extends string>({
  id,
  label,
  current,
  onSelect,
}: {
  id: Id;
  label: string;
  current: Id;
  onSelect: (id: Id) => void;
}) {
  return (
    <button
      aria-selected={current === id}
      className="tab"
      onClick={() => onSelect(id)}
      role="tab"
      type="button"
    >
      {label}
    </button>
  );
}

/** The files of a place, newest first, each with a delete button. Files dropped on the tab upload. */
function FileList({ place }: { place: Place }) {
  const files = filesOf(placeKey(place));
  const { data: rows = [] } = useLiveQuery({
    query: (q) =>
      q.from({ file: files }).orderBy(({ file }) => file.time, "desc"),
  });
  const previews = rows.map((file) => ({
    href: fileHref(place.workspaceId, file.id),
    name: file.name,
    size: file.size,
  }));
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const upload = async (picked: FileList) => {
    setBusy(true);
    try {
      await uploadFiles(place, [...picked]);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a shortcut for the upload button
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the same
    <div
      className="thread-files"
      data-dropping={dropping || undefined}
      onDragLeave={(event) =>
        event.currentTarget.contains(event.relatedTarget as Node) ||
        setDropping(false)
      }
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDropping(true);
        }
      }}
      onDrop={(event) => {
        setDropping(false);
        if (event.dataTransfer.files.length > 0) {
          event.preventDefault();
          upload(event.dataTransfer.files);
        }
      }}
    >
      <form aria-busy={busy || undefined}>
        <Button
          data-file-pick
          icon="plus"
          label="Upload files"
          onClick={() => picker.current?.click()}
        />
        <input
          hidden
          multiple
          onChange={(event) => {
            if (event.target.files) {
              upload(event.target.files);
            }
            event.target.value = "";
          }}
          ref={picker}
          type="file"
        />
      </form>
      {rows.length > 0 ? (
        <div className="list">
          {rows.map((file, index) => (
            <div className="file-row" key={file.id}>
              <a className="list-row" {...previewLink(previews, index)}>
                <Icon name="file" />
                <span className="name">{file.name}</span>
                <span className="meta">{size(file.size)}</span>
              </a>
              <Button
                icon="trash"
                label={`Delete ${file.name}`}
                onClick={() =>
                  files.delete(file.id).isPersisted.promise.catch(showError)
                }
                size="icon"
                variant="ghost"
              />
            </div>
          ))}
        </div>
      ) : (
        <Empty icon="file" title="No files yet" />
      )}
    </div>
  );
}

/** `run` once, a second after the last of a burst of calls, as a streaming answer changes many times a second. */
function useDebounced(run: () => void): () => void {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(run, 1000);
  }, [run]);
}

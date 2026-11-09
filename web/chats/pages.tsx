import { eq, isNull, not, useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { fileHref } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { ChatSummary } from "../app/types.ts";
import { ArtifactList, ArtifactPreview } from "../artifacts/panel.tsx";
import {
  Button,
  Dialog,
  Empty,
  Menu,
  WorkingSpinner,
} from "../ui/components.tsx";
import { previewLink } from "../ui/file-preview.tsx";
import { dayTime, size } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import {
  chatsOf,
  meQuery,
  mergeTopic,
  orchestratorQuery,
  rememberOpened,
  setSettled,
  topicsOf,
} from "../workspaces/data.ts";
import { PanelHeader } from "../workspaces/shell.tsx";
import { ApprovalRequest } from "./approval.tsx";
import { Composer } from "./composer.tsx";
import {
  filesOf,
  messagesOf,
  moveChat,
  type Place,
  placeKey,
  startChat,
  stopChat,
  uploadFiles,
  useChatStream,
} from "./data.ts";
import { continues, followEnd, MessageView } from "./message.tsx";
import { followed, outbox, sendMessage } from "./outbox.ts";

const chatRoute = getRouteApi("/signed-in/w/$workspaceId/chat/$chatId");

/**
 * A chat of the workspace in the address; a chat of another workspace is not found. `orchestratorCards` shows over
 * the composer of the person's orchestrator only.
 */
export function ChatPage({
  orchestratorCards,
}: {
  orchestratorCards: ReactNode;
}) {
  const { workspaceId, chatId } = chatRoute.useParams();
  const orchestrator = useQuery(orchestratorQuery(workspaceId)).data;
  const isOrchestrator = orchestrator?.id === chatId;
  const { data: listed, isReady } = useLiveQuery({
    query: (q) =>
      q
        .from({ chat: chatsOf(workspaceId) })
        .where(({ chat: row }) => eq(row.id, chatId))
        .findOne(),
  });
  const chat = isOrchestrator ? orchestrator : listed;
  if (!chat) {
    return isReady && orchestrator ? (
      <section className="conversation">
        <PanelHeader title="" />
        <Empty title="Not found" />
      </section>
    ) : null;
  }
  return (
    <Chat
      cards={isOrchestrator ? orchestratorCards : null}
      chat={chat}
      chatId={chatId}
      isOrchestrator={isOrchestrator}
      workspaceId={workspaceId}
    />
  );
}

/** A chat: its live transcript and composer, and the panel with its place's artifacts and files. */
function Chat({
  workspaceId,
  chatId,
  chat,
  isOrchestrator,
  cards,
}: {
  workspaceId: string;
  chatId: string;
  chat: ChatSummary;
  isOrchestrator: boolean;
  /** Cards over the composer. */
  cards: ReactNode;
}) {
  const { data: topics = [] } = useLiveQuery({
    query: (q) => q.from({ topic: topicsOf(workspaceId) }),
  });
  const topic = topics.find((candidate) => candidate.id === chat.topicId);
  const { data: messages = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ message: messagesOf(chatId) })
        .orderBy(({ message }) => message.time),
  });
  // The orchestrator belongs to the workspace, not to its topic: its files and artifacts are the workspace's own.
  const place: Place = {
    workspaceId,
    topicId: isOrchestrator ? null : chat.topicId,
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
        .where(({ message }) => eq(message.chatId, chatId))
        .orderBy(({ message }) => message.time),
  });
  const { running, approvals } = useChatStream(
    workspaceId,
    chatId,
    placeChanged
  );
  const me = useQuery(meQuery).data?.user.id;
  const mine = approvals.filter(
    ({ approverId }) => approverId === null || approverId === me
  );
  const working = messages.findLast(
    (message) => message.work?.endedAt === null || message.streaming
  );
  useEffect(() => {
    followed.add(chatId);
    return () => {
      followed.delete(chatId);
    };
  }, [chatId]);
  useEffect(
    () => rememberOpened(`/w/${workspaceId}/chat/${chatId}`),
    [workspaceId, chatId]
  );
  const settled = chat.settledAt !== null;
  return (
    <>
      <section className="conversation">
        <PanelHeader
          title={
            isOrchestrator ? (
              chat.title
            ) : (
              <>
                <span className="breadcrumb">{topic?.name} › </span>
                {chat.title}
              </>
            )
          }
        >
          {isOrchestrator ? null : (
            <>
              <Menu
                entries={[
                  { kind: "label", label: "Move to" },
                  ...topics.map((candidate) => ({
                    kind: "action" as const,
                    label: candidate.name,
                    icon: candidate.ownerId
                      ? ("lock" as const)
                      : ("hash" as const),
                    current: candidate.id === chat.topicId,
                    onSelect: () =>
                      moveChat(workspaceId, chatId, chat.topicId, candidate.id),
                  })),
                ]}
                trigger={
                  <Button
                    icon="forward"
                    label="Move chat"
                    size="icon"
                    variant="ghost"
                  />
                }
              />
              <Button
                icon={settled ? "inbox" : "check"}
                label={settled ? "Un-settle chat" : "Settle chat"}
                onClick={() => setSettled(workspaceId, chatId, !settled)}
                size="icon"
                variant="ghost"
              />
            </>
          )}
          <PanelToggle />
        </PanelHeader>
        <section
          aria-live="polite"
          className="transcript"
          id="transcript"
          ref={followEnd}
        >
          {messages.map((message, index) => (
            <MessageView
              continued={continues(message, messages[index - 1])}
              key={message.id}
              message={message}
              waiting={message === working && mine.length > 0}
              workspaceId={workspaceId}
            />
          ))}
          {mine.map((approval) => (
            <ApprovalRequest
              approval={approval}
              chatId={chatId}
              key={approval.id}
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
        {cards}
        <Composer
          clearAtOnce
          onSend={(text, files) => sendMessage(chatId, text, files)}
          onStop={running ? () => stopChat(chatId).catch(showError) : undefined}
          placeholder={
            isOrchestrator ? "Message Golem" : `Message #${topic?.name ?? ""}`
          }
        />
      </section>
      <PlacePanel place={place} />
    </>
  );
}

const topicRoute = getRouteApi("/signed-in/w/$workspaceId/topic/$topicId");

/**
 * A topic: its chats, settled ones folded away, in up to the top half; its details under them; and the panel with
 * the files and artifacts of all its chats.
 */
export function TopicPage({ details }: { details: ReactNode }) {
  const { workspaceId, topicId } = topicRoute.useParams();
  const navigate = useNavigate();
  const [into, setInto] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const topics = topicsOf(workspaceId);
  const { data: topic, isReady } = useLiveQuery({
    query: (q) =>
      q
        .from({ topic: topics })
        .where(({ topic: row }) => eq(row.id, topicId))
        .findOne(),
  });
  const { data: active = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ chat: chatsOf(workspaceId) })
        .where(({ chat }) => eq(chat.topicId, topicId))
        .where(({ chat }) => isNull(chat.settledAt))
        .orderBy(({ chat }) => chat.updatedAt, "desc"),
  });
  const { data: settled = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ chat: chatsOf(workspaceId) })
        .where(({ chat }) => eq(chat.topicId, topicId))
        .where(({ chat }) => not(isNull(chat.settledAt)))
        .orderBy(({ chat }) => chat.settledAt, "desc"),
  });
  useEffect(
    () => rememberOpened(`/w/${workspaceId}/topic/${topicId}`),
    [workspaceId, topicId]
  );
  if (!topic) {
    return isReady ? (
      <section className="conversation">
        <PanelHeader title="" />
        <Empty title="Not found" />
      </section>
    ) : null;
  }
  // A topic that every member sees merges only into another such topic.
  const targets = [...topics.values()].filter(
    (other) =>
      other.id !== topicId && (topic.ownerId !== null || other.ownerId === null)
  );
  const merge = async () => {
    if (!into) {
      return;
    }
    setBusy(true);
    try {
      await mergeTopic(workspaceId, topicId, into.id);
      setInto(null);
      navigate({
        to: "/w/$workspaceId/topic/$topicId",
        params: { workspaceId, topicId: into.id },
      });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="conversation">
        <PanelHeader
          title={
            <>
              <span className="breadcrumb"># </span>
              {topic.name}
            </>
          }
        >
          {targets.length > 0 ? (
            <Menu
              entries={[
                { kind: "label", label: "Merge into" },
                ...targets.map((target) => ({
                  kind: "action" as const,
                  label: target.name,
                  icon: target.ownerId ? ("lock" as const) : ("hash" as const),
                  onSelect: () => setInto(target),
                })),
              ]}
              trigger={
                <Button
                  icon="forward"
                  label="Merge topic"
                  size="icon"
                  variant="ghost"
                />
              }
            />
          ) : null}
          <PanelToggle />
        </PanelHeader>
        <div className="topic">
          <div className="topic-chats">
            {active.length + settled.length > 0 ? (
              <div className="list">
                {active.map((chat) => (
                  <ChatRow
                    chat={chat}
                    key={chat.id}
                    workspaceId={workspaceId}
                  />
                ))}
                {settled.length > 0 ? (
                  <details className="settled-chats">
                    <summary>Settled ({settled.length})</summary>
                    {settled.map((chat) => (
                      <ChatRow
                        chat={chat}
                        key={chat.id}
                        workspaceId={workspaceId}
                      />
                    ))}
                  </details>
                ) : null}
              </div>
            ) : (
              <Empty title="No chats yet" />
            )}
          </div>
          <div className="topic-details">{details}</div>
        </div>
        <Composer
          onSend={async (text, files) => {
            const chat = await startChat(workspaceId, topicId, text, files);
            navigate({
              to: "/w/$workspaceId/chat/$chatId",
              params: { workspaceId, chatId: chat.id },
            });
          }}
          placeholder={`Start a chat in #${topic.name}`}
        />
        <Dialog
          busy={busy}
          onClose={() => setInto(null)}
          onSubmit={merge}
          open={into !== null}
          submit="Merge"
          title={`Merge #${topic.name} into #${into?.name ?? ""}?`}
        >
          <p>Its chats, files, artifacts, and routines move there.</p>
        </Dialog>
      </section>
      <PlacePanel place={{ workspaceId, topicId }} />
    </>
  );
}

function ChatRow({
  workspaceId,
  chat,
}: {
  workspaceId: string;
  chat: {
    id: string;
    title: string;
    updatedAt: number;
    settledAt: number | null;
  };
}) {
  const settled = chat.settledAt !== null;
  return (
    <div className="file-row">
      <Link
        className="list-row"
        params={{ workspaceId, chatId: chat.id }}
        to="/w/$workspaceId/chat/$chatId"
      >
        <Icon name="compose" />
        <span className="name">{chat.title}</span>
        <WorkingSpinner chatId={chat.id} />
        <span className="meta">{dayTime(chat.updatedAt)}</span>
      </Link>
      <Button
        icon={settled ? "inbox" : "check"}
        label={settled ? "Un-settle chat" : "Settle chat"}
        onClick={() => setSettled(workspaceId, chat.id, !settled)}
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
 * The side panel of a place: its files and artifacts in tabs, and the preview of the artifact that `?artifact=` names,
 * as a list or a search result opens it.
 */
function PlacePanel({ place }: { place: Place }) {
  const [open, setOpen] = usePanelOpen();
  const [tab, setTab] = useState<"files" | "artifacts">("files");
  const { artifact } = placeRoute.useSearch({
    select: (search) => search as { artifact?: string },
  });
  const navigate = useNavigate();
  const key = placeKey(place);
  useEffect(() => {
    if (artifact) {
      panelOpen.set(true);
      // Closing the preview goes back to the artifacts it came from.
      setTab("artifacts");
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
            <Tab current={tab} id="files" label="Files" onSelect={setTab} />
            <Tab
              current={tab}
              id="artifacts"
              label="Artifacts"
              onSelect={setTab}
            />
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
      className="chat-files"
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
        <Empty title="No files yet" />
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

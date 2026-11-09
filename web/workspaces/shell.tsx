import { isNull, not, useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import {
  getRouteApi,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { request } from "../app/api.ts";
import type { ChatSummary, Topic } from "../app/types.ts";
import {
  Button,
  Dialog,
  Switch,
  TextField,
  WorkingContext,
  WorkingSpinner,
} from "../ui/components.tsx";
import { Icon, type IconName } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import {
  chatsOf,
  foldedTopics,
  inboxQuery,
  meQuery,
  orchestratorQuery,
  refreshInbox,
  refreshWorkspace,
  rememberFolded,
  setSettled,
  topicsOf,
  useMe,
} from "./data.ts";

/** The signed-in pages show once the person and their workspaces are known; a signed-out person goes to sign in. */
export function SignedIn() {
  return useQuery(meQuery).data ? <Outlet /> : null;
}

const workspaceRoute = getRouteApi("/signed-in/w/$workspaceId");

/** A workspace's pages, in the shell. Someone who is not a member sees not found. */
export function WorkspaceLayout() {
  const { workspaceId } = workspaceRoute.useParams();
  const member = useMe().workspaces.some(
    (workspace) => workspace.id === workspaceId
  );
  if (!member) {
    return (
      <div className="empty">
        <strong>Not found</strong>
      </div>
    );
  }
  return (
    <Shell workspaceId={workspaceId}>
      <Outlet />
    </Shell>
  );
}

const SidebarContext = createContext<() => void>(() => undefined);

/** The app: the workspace and its topics with their chats on the left, the page in the inset panel. */
export function Shell({
  workspaceId,
  children,
}: {
  workspaceId: string | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const working = useWorking(workspaceId);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // On narrow screens the sidebar closes when a page opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs when the page changes
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    // `/` opens search, outside text fields.
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !workspaceId ||
        target?.closest("input, textarea, select, [contenteditable]")
      ) {
        return;
      }
      event.preventDefault();
      navigate({ to: "/w/$workspaceId/search", params: { workspaceId } });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [workspaceId, navigate]);
  return (
    <WorkingContext value={working}>
      <SidebarContext value={() => setOpen((value) => !value)}>
        <div className="app">
          <aside className={open ? "sidebar is-open" : "sidebar"}>
            <Sidebar workspaceId={workspaceId} />
          </aside>
          <main className="panel">{children}</main>
        </div>
      </SidebarContext>
    </WorkingContext>
  );
}

/** The panel's header bar, with the menu button on narrow screens. */
export function PanelHeader({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="panel-header">
      <span className="only-narrow">
        <SidebarButton />
      </span>
      <h1 className="title">{title}</h1>
      {children}
    </header>
  );
}

/** Settings-style pages have a page title instead of a header bar, and the menu button floats. */
export function FloatingSidebarButton() {
  return (
    <span className="only-narrow floating-menu">
      <SidebarButton />
    </span>
  );
}

function SidebarButton() {
  return (
    <Button
      icon="sidebar"
      label="Menu"
      onClick={useContext(SidebarContext)}
      size="icon"
      variant="ghost"
    />
  );
}

/**
 * The chats whose agent works, from the workspace's working stream. Agents start chats and topics as they work,
 * so the topics and chats load again whenever work starts or ends.
 */
function useWorking(workspaceId: string | undefined): ReadonlySet<string> {
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    const source = new EventSource(`/api/v1/workspaces/${workspaceId}/working`);
    source.addEventListener("working", (event) => {
      const { chatIds } = JSON.parse(event.data) as { chatIds: string[] };
      setWorking(new Set(chatIds));
      refreshWorkspace(workspaceId);
      // A run that ends notifies a moment later.
      setTimeout(() => refreshInbox(workspaceId), 1000);
    });
    return () => {
      source.close();
      setWorking(new Set());
    };
  }, [workspaceId]);
  return working;
}

function Sidebar({ workspaceId }: { workspaceId: string | undefined }) {
  const me = useMe();
  const workspace = me.workspaces.find(
    (candidate) => candidate.id === workspaceId
  );
  const [dialog, setDialog] = useState<"topic" | null>(null);
  return (
    <div className="sidebar-content">
      {workspace ? (
        <WorkspaceNav
          onNewTopic={() => setDialog("topic")}
          workspaceId={workspace.id}
        />
      ) : (
        <div className="sidebar-topics" />
      )}
      <nav className="nav sidebar-footer">
        {workspace ? (
          <Link
            activeOptions={{ exact: true }}
            className="nav-item"
            params={{ workspaceId: workspace.id }}
            to="/w/$workspaceId/settings"
          >
            <NavContent icon="members" label="Workspace settings" />
          </Link>
        ) : null}
        <Link className="nav-item" to="/settings">
          <NavContent icon="settings" label="Settings" />
        </Link>
      </nav>
      {workspace ? (
        <NewTopicDialog
          onClose={() => setDialog(null)}
          open={dialog === "topic"}
          workspaceId={workspace.id}
        />
      ) : null}
    </div>
  );
}

/** The workspace's orchestrator, inbox, upcoming, and search, its topics with their active chats, which fold, and the settled chats. */
function WorkspaceNav({
  workspaceId,
  onNewTopic,
}: {
  workspaceId: string;
  onNewTopic: () => void;
}) {
  const { owner } = useMe();
  const orchestrator = useQuery(orchestratorQuery(workspaceId)).data;
  const unread = useQuery(inboxQuery(workspaceId)).data?.unread;
  const { pathname } = useLocation();
  // An open chat reads its notifications.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs when the page changes
  useEffect(() => {
    refreshInbox(workspaceId);
  }, [workspaceId, pathname]);
  const { data: topics = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ topic: topicsOf(workspaceId) })
        .orderBy(({ topic }) => topic.order),
  });
  const { data: active = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ chat: chatsOf(workspaceId) })
        .where(({ chat }) => isNull(chat.settledAt))
        .orderBy(({ chat }) => chat.updatedAt, "desc"),
  });
  const { data: settled = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ chat: chatsOf(workspaceId) })
        .where(({ chat }) => not(isNull(chat.settledAt)))
        .orderBy(({ chat }) => chat.settledAt, "desc"),
  });
  const [folded, setFolded] = useState(foldedTopics);
  const toggleFolded = (topicId: string) => {
    const next = folded.includes(topicId)
      ? folded.filter((id) => id !== topicId)
      : [...folded, topicId];
    setFolded(next);
    rememberFolded(next);
  };
  const topicItem = (topic: Omit<Topic, "chats">) => {
    const chats = active.filter((chat) => chat.topicId === topic.id);
    const open = !folded.includes(topic.id);
    return (
      <div key={topic.id}>
        <div className="sidebar-topic">
          <Link
            activeOptions={{ exact: true, includeSearch: false }}
            className="nav-item"
            params={{ workspaceId, topicId: topic.id }}
            to="/w/$workspaceId/topic/$topicId"
          >
            <NavContent
              emoji={topic.icon}
              icon="hash"
              label={topic.name}
              locked={topic.ownerId !== null}
            />
          </Link>
          {chats.length > 0 ? (
            <span className="fold-action">
              <Button
                aria-expanded={open}
                icon="disclosure"
                label={open ? "Fold chats" : "Unfold chats"}
                onClick={() => toggleFolded(topic.id)}
                size="tiny"
                variant="ghost"
              />
            </span>
          ) : null}
        </div>
        {open ? (
          <div className="nav-chats">
            {chats.map((chat) => (
              <ChatNav chat={chat} key={chat.id} workspaceId={workspaceId} />
            ))}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <>
      <div className="sidebar-topics">
        <nav className="nav">
          {orchestrator ? (
            <Link
              className="nav-item"
              params={{ workspaceId, chatId: orchestrator.id }}
              to="/w/$workspaceId/chat/$chatId"
            >
              <NavContent chatId={orchestrator.id} icon="golem" label="Golem" />
            </Link>
          ) : null}
          <Link
            className="nav-item"
            params={{ workspaceId }}
            to="/w/$workspaceId/inbox"
          >
            <NavContent count={unread} icon="bell" label="Inbox" />
          </Link>
          <Link
            className="nav-item"
            params={{ workspaceId }}
            to="/w/$workspaceId/upcoming"
          >
            <NavContent icon="clock" label="Upcoming" />
          </Link>
          <Link
            className="nav-item"
            params={{ workspaceId }}
            to="/w/$workspaceId/following"
          >
            <NavContent icon="eye" label="Following" />
          </Link>
          <Link
            className="nav-item"
            params={{ workspaceId }}
            to="/w/$workspaceId/search"
          >
            <NavContent icon="search" label="Search" />
          </Link>
        </nav>
        <nav aria-label="Topics" className="nav">
          <div className="nav-section">
            Topics
            <Button
              icon="plus"
              label="New topic"
              onClick={onNewTopic}
              size="tiny"
              variant="ghost"
            />
          </div>
          {topics.filter((topic) => topic.ownerId === null).map(topicItem)}
        </nav>
        {owner || topics.some((topic) => topic.ownerId !== null) ? (
          <nav aria-label="Private topics" className="nav">
            <div className="nav-section">Private</div>
            {topics.filter((topic) => topic.ownerId !== null).map(topicItem)}
            {owner ? (
              <Link
                className="nav-item"
                params={{ workspaceId }}
                to="/w/$workspaceId/feedback"
              >
                <NavContent icon="info" label="Feedback" />
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
      {settled.length > 0 ? (
        <details className="sidebar-settled">
          <summary className="nav-section">
            Settled ({settled.length})
            <span className="disclosure">
              <Icon name="disclosure" />
            </span>
          </summary>
          <nav aria-label="Settled chats" className="settled-list">
            {settled.map((chat) => (
              <ChatNav chat={chat} key={chat.id} workspaceId={workspaceId} />
            ))}
          </nav>
        </details>
      ) : null}
    </>
  );
}

function ChatNav({
  workspaceId,
  chat,
}: {
  workspaceId: string;
  chat: ChatSummary;
}) {
  const settled = chat.settledAt !== null;
  return (
    <div className="sidebar-chat">
      <Link
        className="nav-item"
        params={{ workspaceId, chatId: chat.id }}
        to="/w/$workspaceId/chat/$chatId"
      >
        <NavContent chatId={chat.id} icon="compose" label={chat.title} />
      </Link>
      <span className="settle-action">
        <Button
          icon={settled ? "inbox" : "check"}
          label={settled ? "Un-settle chat" : "Settle chat"}
          onClick={() => setSettled(workspaceId, chat.id, !settled)}
          size="tiny"
          variant="ghost"
        />
      </span>
    </div>
  );
}

export function NavContent({
  icon,
  emoji,
  label,
  chatId,
  count,
  locked = false,
}: {
  icon: IconName;
  /** Shows in place of the icon when set. */
  emoji?: string | null;
  label: string;
  /** A private topic, which only its person sees. */
  locked?: boolean;
  /** A chat whose spinner shows while its agent works. */
  chatId?: string;
  /** Shows when it is more than 0. */
  count?: number;
}) {
  return (
    <>
      {emoji ? (
        <span aria-hidden className="emoji">
          {emoji}
        </span>
      ) : (
        <Icon name={icon} />
      )}
      <span className="label">{label}</span>
      {locked ? (
        <span className="lock" title="Private">
          <Icon name="lock" />
        </span>
      ) : null}
      {chatId ? <WorkingSpinner chatId={chatId} /> : null}
      {count ? <span className="count">{count}</span> : null}
    </>
  );
}

function NewTopicDialog({
  workspaceId,
  open,
  onClose,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [isPrivate, setPrivate] = useState(false);
  return (
    <Dialog
      busy={busy}
      onClose={onClose}
      onSubmit={async (form) => {
        setBusy(true);
        try {
          const topic = await request<{ id: string }>(
            `/workspaces/${workspaceId}/topics`,
            {
              method: "POST",
              body: { name: String(form.get("name")), private: isPrivate },
            }
          );
          await refreshWorkspace(workspaceId);
          onClose();
          navigate({
            to: "/w/$workspaceId/topic/$topicId",
            params: { workspaceId, topicId: topic.id },
          });
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }}
      open={open}
      submit="Create topic"
      title="New topic"
    >
      <TextField
        autoFocus
        label="Name"
        name="name"
        placeholder="trips"
        required
      />
      <div className="field-switch">
        Private
        <Switch checked={isPrivate} label="Private" onChange={setPrivate} />
      </div>
    </Dialog>
  );
}

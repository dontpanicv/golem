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
import { signOut } from "../accounts/login.tsx";
import { request } from "../app/api.ts";
import type { Channel, ThreadSummary } from "../app/types.ts";
import {
  Avatar,
  Button,
  Dialog,
  Menu,
  Switch,
  TextField,
  WorkingContext,
  WorkingSpinner,
} from "../ui/components.tsx";
import { Icon, type IconName } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import {
  channelsOf,
  inboxQuery,
  meQuery,
  orchestratorQuery,
  refreshInbox,
  refreshWorkspace,
  setSettled,
  threadsOf,
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

/** The app: the workspace and its channels with their threads on the left, the page in the inset panel. */
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
 * The threads whose agent works, from the workspace's working stream. Agents start threads and channels as they work,
 * so the channels and threads load again whenever work starts or ends.
 */
function useWorking(workspaceId: string | undefined): ReadonlySet<string> {
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    const source = new EventSource(`/api/v1/workspaces/${workspaceId}/working`);
    source.addEventListener("working", (event) => {
      const { threadIds } = JSON.parse(event.data) as { threadIds: string[] };
      setWorking(new Set(threadIds));
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
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<"channel" | null>(null);
  return (
    <div className="sidebar-content">
      <div className="sidebar-header">
        <Menu
          align="start"
          entries={[
            ...(workspace
              ? [
                  {
                    kind: "action" as const,
                    label: "Workspace settings",
                    icon: "members" as const,
                    onSelect: () =>
                      navigate({
                        to: "/w/$workspaceId/settings",
                        params: { workspaceId: workspace.id },
                      }),
                  },
                ]
              : []),
            {
              kind: "action",
              label: "Settings",
              icon: "settings",
              onSelect: () => navigate({ to: "/settings" }),
            },
            { kind: "separator" },
            {
              kind: "action",
              label: "Sign out",
              icon: "logout",
              onSelect: () => signOut(),
            },
          ]}
          trigger={
            <button className="workspace-trigger" type="button">
              <Avatar agent name={workspace?.name ?? "Golem"} size="small" />
              <span className="name">{workspace?.name ?? "Golem"}</span>
              <Icon name="chevron" />
            </button>
          }
        />
      </div>
      {workspace ? (
        <WorkspaceNav
          onNewChannel={() => setDialog("channel")}
          workspaceId={workspace.id}
        />
      ) : (
        <div className="sidebar-channels" />
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
        <NewChannelDialog
          onClose={() => setDialog(null)}
          open={dialog === "channel"}
          workspaceId={workspace.id}
        />
      ) : null}
    </div>
  );
}

/** The workspace's orchestrator and search, its channels with their active threads, and the settled threads. */
function WorkspaceNav({
  workspaceId,
  onNewChannel,
}: {
  workspaceId: string;
  onNewChannel: () => void;
}) {
  const orchestrator = useQuery(orchestratorQuery(workspaceId)).data;
  const unread = useQuery(inboxQuery(workspaceId)).data?.unread;
  const { pathname } = useLocation();
  // An open thread reads its notifications.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs when the page changes
  useEffect(() => {
    refreshInbox(workspaceId);
  }, [workspaceId, pathname]);
  const { data: channels = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ channel: channelsOf(workspaceId) })
        .orderBy(({ channel }) => channel.order),
  });
  const { data: active = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ thread: threadsOf(workspaceId) })
        .where(({ thread }) => isNull(thread.settledAt))
        .orderBy(({ thread }) => thread.updatedAt, "desc"),
  });
  const { data: settled = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ thread: threadsOf(workspaceId) })
        .where(({ thread }) => not(isNull(thread.settledAt)))
        .orderBy(({ thread }) => thread.settledAt, "desc"),
  });
  const channelItem = (channel: Omit<Channel, "threads">) => (
    <div key={channel.id}>
      <Link
        activeOptions={{ exact: true, includeSearch: false }}
        className="nav-item"
        params={{ workspaceId, channelId: channel.id }}
        to="/w/$workspaceId/c/$channelId"
      >
        <NavContent
          emoji={channel.icon}
          icon="hash"
          label={channel.name}
          locked={channel.ownerId !== null}
        />
      </Link>
      <div className="nav-threads">
        {active
          .filter((thread) => thread.channelId === channel.id)
          .map((thread) => (
            <ThreadNav
              key={thread.id}
              thread={thread}
              workspaceId={workspaceId}
            />
          ))}
      </div>
    </div>
  );
  return (
    <>
      <div className="sidebar-channels">
        <nav className="nav">
          {orchestrator ? (
            <Link
              className="nav-item"
              params={{ workspaceId, threadId: orchestrator.id }}
              to="/w/$workspaceId/t/$threadId"
            >
              <NavContent
                icon="inbox"
                label="Golem"
                threadId={orchestrator.id}
              />
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
            to="/w/$workspaceId/search"
          >
            <NavContent icon="search" label="Search" />
          </Link>
        </nav>
        <nav aria-label="Channels" className="nav">
          <div className="nav-section">
            Channels
            <Button
              icon="plus"
              label="New channel"
              onClick={onNewChannel}
              size="tiny"
              variant="ghost"
            />
          </div>
          {channels
            .filter((channel) => channel.ownerId === null)
            .map(channelItem)}
        </nav>
        {channels.some((channel) => channel.ownerId !== null) ? (
          <nav aria-label="Private channels" className="nav">
            <div className="nav-section">Private</div>
            {channels
              .filter((channel) => channel.ownerId !== null)
              .map(channelItem)}
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
          <nav aria-label="Settled threads" className="settled-list">
            {settled.map((thread) => (
              <ThreadNav
                key={thread.id}
                thread={thread}
                workspaceId={workspaceId}
              />
            ))}
          </nav>
        </details>
      ) : null}
    </>
  );
}

function ThreadNav({
  workspaceId,
  thread,
}: {
  workspaceId: string;
  thread: ThreadSummary;
}) {
  const settled = thread.settledAt !== null;
  return (
    <div className="sidebar-thread">
      <Link
        className="nav-item"
        params={{ workspaceId, threadId: thread.id }}
        to="/w/$workspaceId/t/$threadId"
      >
        <NavContent icon="compose" label={thread.title} threadId={thread.id} />
      </Link>
      <span className="settle-action">
        <Button
          icon={settled ? "inbox" : "check"}
          label={settled ? "Un-settle thread" : "Settle thread"}
          onClick={() => setSettled(workspaceId, thread.id, !settled)}
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
  threadId,
  count,
  locked = false,
}: {
  icon: IconName;
  /** Shows in place of the icon when set. */
  emoji?: string | null;
  label: string;
  /** A private channel, which only its person sees. */
  locked?: boolean;
  /** A thread whose spinner shows while its agent works. */
  threadId?: string;
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
      {threadId ? <WorkingSpinner threadId={threadId} /> : null}
      {count ? <span className="count">{count}</span> : null}
    </>
  );
}

function NewChannelDialog({
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
          const channel = await request<{ id: string }>(
            `/workspaces/${workspaceId}/channels`,
            {
              method: "POST",
              body: { name: String(form.get("name")), private: isPrivate },
            }
          );
          await refreshWorkspace(workspaceId);
          onClose();
          navigate({
            to: "/w/$workspaceId/c/$channelId",
            params: { workspaceId, channelId: channel.id },
          });
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }}
      open={open}
      submit="Create channel"
      title="New channel"
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

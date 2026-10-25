import type { AuthedInput } from "../app/http.ts";
import { toastOf } from "../app/web.ts";
import type { User } from "../platform/auth.ts";
import {
  avatar,
  button,
  dialog,
  htmlDocument,
  menu,
  navItem,
  type Toast,
  textField,
} from "../platform/ui/components.ts";
import { icon } from "../platform/ui/icons.ts";
import type { Channel, Workspace } from "./workspaces.ts";

const escapeHtml = Bun.escapeHTML;

export interface ShellContext {
  readonly user: User;
  readonly workspaces: readonly Workspace[];
  readonly workspace?: Workspace;
  readonly channels?: readonly Channel[];
  /** The workspace's thread that never ends, once it has one. */
  readonly orchestratorId?: string;
  readonly current?: {
    readonly channelId?: string;
    readonly threadId?: string;
    readonly page?: "workspace-settings" | "settings" | "search";
  };
  readonly toast?: Toast;
}

export interface ShellPage {
  readonly title: string;
  /** The panel's header bar; settings pages leave it out and show a page title instead. */
  readonly header?: string;
  readonly main: string;
  readonly headerActions?: string;
  /** Adds the artifacts panel of a thread, with its lists and artifact preview. */
  readonly artifacts?: {
    readonly artifacts: string;
    readonly files: string;
    readonly preview: string;
  };
  /** Extra `data-signals` entries and a `data-init` expression for the page body. */
  readonly signals?: string;
  readonly init?: string;
}

/** The shell of a workspace page: the person, their workspaces, and the channels of the workspace in the path. */
export function shellContext(
  input: AuthedInput,
  current: ShellContext["current"]
): ShellContext {
  const { app, user, params } = input;
  const workspace = app.workspaces.requireMember(params.workspace!, user);
  return {
    user,
    workspaces: app.workspaces.list(user),
    workspace,
    channels: app.workspaces.channels(workspace.id, user),
    orchestratorId: app.workspaces.orchestratorOf(workspace.id)?.id,
    current,
    toast: toastOf(input.request),
  };
}

const OPENED_COOKIE = "golem-opened";

/** Remembers the channel or thread page of `request`, so the app opens on it next time. */
export function rememberOpened(request: Request, response: Response): Response {
  const cookie = new Bun.Cookie(OPENED_COOKIE, new URL(request.url).pathname, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  response.headers.append("set-cookie", cookie.serialize());
  return response;
}

/** The workspace and the channel or thread id of the last page `rememberOpened` saw. */
export function lastOpened(
  request: Request
): { workspaceId: string; channelId?: string; threadId?: string } | undefined {
  const path = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
    OPENED_COOKIE
  );
  const [, workspaceId, kind, id] =
    path?.match(/^\/w\/([^/]+)\/(c|t)\/([^/]+)$/) ?? [];
  if (!workspaceId) {
    return undefined;
  }
  return kind === "c"
    ? { workspaceId, channelId: id }
    : { workspaceId, threadId: id };
}

/** The app: workspace and channels with their threads on the left, the page in the inset panel. */
export function shell(context: ShellContext, page: ShellPage): string {
  const signals = `{sidebar: false, artifacts: matchMedia('(min-width: 1001px)').matches, tab: 'artifacts', working: {}${page.signals ? `, ${page.signals}` : ""}}`;
  const menuButton = button("Menu", {
    variant: "ghost",
    icon: "sidebar",
    size: "icon",
    attributes: 'type="button" data-on:click="$sidebar = !$sidebar"',
  });
  const header =
    page.header === undefined
      ? `<span class="only-narrow floating-menu">${menuButton}</span>`
      : `<header class="panel-header">
				<span class="only-narrow">${menuButton}</span>
				<h1 class="title">${page.header}</h1>
				${page.headerActions ?? ""}
				${page.artifacts ? button("Artifacts", { variant: "ghost", icon: "panel", size: "icon", attributes: `type="button" data-on:click="$artifacts = !$artifacts" data-attr:aria-pressed="$artifacts ? 'true' : 'false'"` }) : ""}
			</header>`;
  const body = `<div class="app">
	${sidebar(context)}
	<main class="panel">
		<section class="conversation">
			${header}
			${page.main}
		</section>
		${page.artifacts ? artifactsPanel(page.artifacts) : ""}
	</main>
</div>
${dialogs(context)}`;
  return htmlDocument(
    `${page.title} · Golem`,
    body,
    `data-signals="${escapeHtml(signals)}"${page.init ? ` data-init="${escapeHtml(page.init)}"` : ""}`,
    context.toast ?? null
  );
}

function sidebar(context: ShellContext): string {
  const { workspace, current } = context;
  // The working stream follows which threads work and patches the content when threads or channels change.
  const page = new URLSearchParams(
    Object.entries(current ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
  const working = workspace
    ? ` data-init="${escapeHtml(`@get('/w/${workspace.id}/working?${page}')`)}"`
    : "";
  return `<aside class="sidebar" data-class:is-open="$sidebar"${working}>${sidebarContent(context)}</aside>`;
}

/** The sidebar inside its frame, which the working stream patches. */
export function sidebarContent(context: ShellContext): string {
  const { workspace, current } = context;
  const settled = (context.channels ?? [])
    .flatMap((channel) => channel.threads)
    .filter((thread) => thread.settledAt !== null)
    .sort((left, right) => right.settledAt! - left.settledAt!);
  const switcher = menu(
    `<button type="button" class="workspace-trigger" data-popover-trigger aria-haspopup="menu" aria-expanded="false">${avatar(workspace?.name ?? "Golem", { agent: true, size: "small" })}<span class="name">${escapeHtml(workspace?.name ?? "Golem")}</span>${icon("chevron")}</button>`,
    [
      { kind: "label", label: "Workspaces" },
      ...context.workspaces.map((candidate) => ({
        kind: "link" as const,
        label: candidate.name,
        href: `/w/${candidate.id}`,
        current: candidate.id === workspace?.id,
      })),
      { kind: "separator" },
      {
        kind: "action",
        label: "New workspace",
        icon: "plus",
        attributes: 'type="button" data-dialog-open="new-workspace"',
      },
      ...(workspace
        ? [
            {
              kind: "link" as const,
              label: "Workspace settings",
              icon: "members" as const,
              href: `/w/${workspace.id}/settings`,
            },
          ]
        : []),
      { kind: "link", label: "Settings", icon: "settings", href: "/settings" },
      { kind: "separator" },
      {
        kind: "action",
        label: "Sign out",
        icon: "logout",
        attributes: 'type="submit" form="sign-out"',
      },
    ],
    "start"
  );
  const search = workspace
    ? `<nav class="nav">${navItem("Golem", { icon: "inbox", href: `/w/${workspace.id}/orchestrator`, current: current?.threadId !== undefined && current.threadId === context.orchestratorId, threadId: context.orchestratorId })}${navItem("Search", { icon: "search", href: `/w/${workspace.id}/search`, current: current?.page === "search" }).replace("<a ", '<a data-hotkey="/" ')}</nav>`
    : "";
  const channels = workspace
    ? `<nav class="nav" aria-label="Channels">
			<div class="nav-section">Channels${button("New channel", { variant: "ghost", icon: "plus", size: "tiny", attributes: 'type="button" data-dialog-open="new-channel"' })}</div>
			${(context.channels ?? []).map((channel) => channelNav(workspace, channel, current)).join("")}
		</nav>`
    : "";
  return `<div id="sidebar-content" class="sidebar-content">
		<div class="sidebar-header">${switcher}</div>
		<div class="sidebar-channels">${search}${channels}</div>
		${settled.length ? `<details id="sidebar-settled" class="sidebar-settled" data-preserve-attr="open"><summary class="nav-section">Settled (${settled.length})<span class="disclosure">${icon("disclosure")}</span></summary><nav class="settled-list" aria-label="Settled threads">${settled.map((thread) => threadNav(workspace!, thread, current)).join("")}</nav></details>` : ""}
		<nav class="nav sidebar-footer">
			${workspace ? navItem("Workspace settings", { icon: "members", href: `/w/${workspace.id}/settings`, current: current?.page === "workspace-settings" }) : ""}
			${navItem("Settings", { icon: "settings", href: "/settings", current: current?.page === "settings" })}
		</nav>
		<form id="sign-out" method="post" action="/logout" hidden></form>
	</div>`;
}

function dialogs(context: ShellContext): string {
  const newWorkspace = dialog("new-workspace", {
    title: "New workspace",
    action: "/workspaces",
    submit: "Create workspace",
    body: textField("Name", {
      name: "name",
      placeholder: "Family",
      required: true,
      autofocus: true,
    }),
  });
  const newChannel = context.workspace
    ? dialog("new-channel", {
        title: "New channel",
        action: `/w/${context.workspace.id}/channels`,
        submit: "Create channel",
        body: textField("Name", {
          name: "name",
          placeholder: "trips",
          required: true,
          autofocus: true,
        }),
      })
    : "";
  return newWorkspace + newChannel;
}

function channelNav(
  workspace: Workspace,
  channel: Channel,
  current: ShellContext["current"]
): string {
  const threads = channel.threads
    .filter((thread) => thread.settledAt === null)
    .map((thread) => threadNav(workspace, thread, current))
    .join("");
  const isCurrent =
    channel.id === current?.channelId && current.threadId === undefined;
  return `${navItem(channel.name, { icon: "hash", href: `/w/${workspace.id}/c/${channel.id}`, current: isCurrent })}<div class="nav-threads">${threads}</div>`;
}

function threadNav(
  workspace: Workspace,
  thread: Channel["threads"][number],
  current: ShellContext["current"]
): string {
  const settled = thread.settledAt !== null;
  return `<div class="sidebar-thread">${navItem(thread.title, {
    icon: "compose",
    href: `/w/${workspace.id}/t/${thread.id}`,
    current: thread.id === current?.threadId,
    threadId: thread.id,
  })}<form class="settle-action" method="post" action="/w/${workspace.id}/t/${thread.id}/settled"><input type="hidden" name="settled" value="${!settled}">${button(settled ? "Un-settle thread" : "Settle thread", { variant: "ghost", icon: settled ? "inbox" : "check", size: "tiny", attributes: 'type="submit"' })}</form></div>`;
}

function artifactsPanel(tabs: NonNullable<ShellPage["artifacts"]>): string {
  return `<aside class="artifacts" data-show="$artifacts" aria-label="Artifacts">
		<header class="panel-header">
			<div class="tabs" role="tablist" data-show="$tab !== 'preview'">${tab("artifacts", "Artifacts")}${tab("files", "Files")}</div>
			${button("Close preview", { variant: "ghost", size: "small", attributes: 'type="button" data-show="$tab === \'preview\'" style="display: none; margin-right: auto" data-on:click="$tab = \'artifacts\'"' })}
			${button("Close artifacts", { variant: "ghost", icon: "close", size: "icon", attributes: 'type="button" data-on:click="$artifacts = false"' })}
		</header>
		${tabs.artifacts}
		${tabs.files}
		${tabs.preview}
	</aside>`;
}

function tab(id: string, label: string): string {
  return `<button type="button" role="tab" class="tab" data-attr:aria-selected="$tab === '${id}' ? 'true' : 'false'" data-on:click="$tab = '${id}'">${label}</button>`;
}

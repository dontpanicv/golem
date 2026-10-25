import type { User } from "../auth.ts";
import type { Message, ThreadMessages } from "../threads.ts";
import type { Channel, Workspace } from "../workspaces.ts";
import { button, htmlDocument, message, navItem } from "./components.ts";
import { icon } from "./icons.ts";

const escape = Bun.escapeHTML;

export type ShellContext = {
	readonly user: User;
	readonly workspaces: readonly Workspace[];
	readonly workspace?: Workspace;
	readonly channels?: readonly Channel[];
	readonly current?: { readonly channelId?: string; readonly threadId?: string; readonly page?: "workspace-settings" | "settings" };
};

export type ShellPage = {
	readonly title: string;
	readonly header: string;
	readonly main: string;
	readonly headerActions?: string;
	/** Adds the artifacts panel of a thread. */
	readonly artifacts?: boolean;
	/** Extra `data-signals` entries and a `data-init` expression for the page body. */
	readonly signals?: string;
	readonly init?: string;
};

/** The app: workspace and channels with their threads on the left, the page in the inset panel. */
export function shell(context: ShellContext, page: ShellPage): string {
	const signals = `{sidebar: false, artifacts: matchMedia('(min-width: 1001px)').matches, tab: 'artifacts', message: ''${page.signals ? `, ${page.signals}` : ""}}`;
	const body = `<div class="app">
	${sidebar(context)}
	<main class="panel">
		<section class="conversation">
			<header class="panel-header">
				<span class="only-narrow">${button("Menu", { variant: "ghost", icon: "sidebar", iconOnly: true, small: true, attributes: 'type="button" data-on:click="$sidebar = !$sidebar"' })}</span>
				<h1 class="title">${page.header}</h1>
				${page.headerActions ?? ""}
				${page.artifacts ? button("Artifacts", { variant: "ghost", icon: "panel", iconOnly: true, small: true, attributes: `type="button" data-on:click="$artifacts = !$artifacts" data-attr:aria-pressed="$artifacts ? 'true' : 'false'"` }) : ""}
			</header>
			${page.main}
		</section>
		${page.artifacts ? artifactsPanel() : ""}
	</main>
</div>`;
	return htmlDocument(`${page.title} · Golem`, body, `data-signals="${escape(signals)}"${page.init ? ` data-init="${escape(page.init)}"` : ""}`);
}

function sidebar(context: ShellContext): string {
	const { workspace, current } = context;
	const options = context.workspaces
		.map((candidate) => `<option value="/w/${candidate.id}"${candidate.id === workspace?.id ? " selected" : ""}>${escape(candidate.name)}</option>`)
		.join("");
	const channels = workspace
		? `<nav class="nav" aria-label="Channels">
			<div class="nav-section">Channels
				<details class="new-channel">
					<summary class="button ghost small icon-only" aria-label="New channel" title="New channel">${icon("plus")}</summary>
					<form method="post" action="/w/${workspace.id}/channels">
						<input class="input" name="name" placeholder="channel-name" aria-label="Channel name" required>
						<button class="button small">Create</button>
					</form>
				</details>
			</div>
			${(context.channels ?? []).map((channel) => channelNav(workspace, channel, current)).join("")}
		</nav>`
		: "";
	return `<aside class="sidebar" data-class:is-open="$sidebar">
		<div class="sidebar-header">
			<span class="avatar agent small" aria-hidden="true">G</span>
			<select class="switcher" aria-label="Workspace" data-on:change="window.location.href = evt.target.value">
				${workspace ? "" : '<option value="" selected>Choose a workspace</option>'}${options}
				<option value="/workspaces/new">New workspace…</option>
			</select>
		</div>
		${channels}
		<nav class="nav sidebar-footer">
			${workspace ? navItem("Workspace settings", { icon: "members", href: `/w/${workspace.id}/settings`, current: current?.page === "workspace-settings" }) : ""}
			${navItem("Settings", { icon: "settings", href: "/settings", current: current?.page === "settings" })}
		</nav>
	</aside>`;
}

function channelNav(workspace: Workspace, channel: Channel, current: ShellContext["current"]): string {
	const threads = channel.threads
		.map((thread) =>
			navItem(thread.title, { icon: "compose", href: `/w/${workspace.id}/t/${thread.id}`, current: thread.id === current?.threadId }),
		)
		.join("");
	const isCurrent = channel.id === current?.channelId && current.threadId === undefined;
	return `${navItem(channel.name, { icon: "hash", href: `/w/${workspace.id}/c/${channel.id}`, current: isCurrent })}<div class="nav-threads">${threads}</div>`;
}

function artifactsPanel(): string {
	return `<aside class="artifacts" data-show="$artifacts" aria-label="Artifacts">
		<header class="panel-header">
			<div class="tabs" role="tablist">${tab("artifacts", "Artifacts")}${tab("files", "Files")}${tab("preview", "Preview")}</div>
			${button("Close", { variant: "ghost", icon: "panel", iconOnly: true, small: true, attributes: 'type="button" data-on:click="$artifacts = false"' })}
		</header>
		<div class="empty" data-show="$tab === 'artifacts'">${icon("artifact")}<strong>No artifacts yet</strong></div>
		<div class="empty" data-show="$tab === 'files'" style="display: none">${icon("file")}<strong>No files yet</strong></div>
		<div class="empty" data-show="$tab === 'preview'" style="display: none">${icon("preview")}<strong>Nothing to preview</strong></div>
	</aside>`;
}

function tab(id: string, label: string): string {
	return `<button type="button" role="tab" class="tab" data-attr:aria-selected="$tab === '${id}' ? 'true' : 'false'" data-on:click="$tab = '${id}'">${label}</button>`;
}

/** The transcript element that the thread's event stream patches after every change. */
export function transcript(state: ThreadMessages): string {
	const items = state.messages.map((m: Message) => message(m)).join("");
	const working = state.running && !state.messages.some((m) => m.streaming) ? '<p class="working">Golem is working…</p>' : "";
	const empty = items === "" && !working ? '<div class="empty"><strong>Ask Golem anything</strong></div>' : "";
	return `<section id="transcript" class="transcript" aria-live="polite">${items}${working}${empty}</section>`;
}

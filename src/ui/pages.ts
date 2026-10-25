import type { LlmStatus } from "../llm.ts";
import type { Channel, Integration, Member, ThreadSummary } from "../workspaces.ts";
import { badge, banner, button, composer, empty, htmlDocument } from "./components.ts";
import { icon } from "./icons.ts";
import { type ShellContext, shell } from "./shell.ts";

const escape = Bun.escapeHTML;

export function authPage(mode: "login" | "signup", error: string | null): string {
	const signup = mode === "signup";
	const body = `<main class="auth">
	<form class="card" method="post" action="/${mode}">
		<h1><span class="avatar agent" aria-hidden="true">G</span>${signup ? "Create your account" : "Sign in to Golem"}</h1>
		${banner(error)}
		${signup ? field("Name", '<input class="input" name="name" autocomplete="name" required>') : ""}
		${field("Email", '<input class="input" name="email" type="email" autocomplete="email" required>')}
		${field("Password", `<input class="input" name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="8" required>`)}
		${button(signup ? "Create account" : "Sign in", { variant: "primary", attributes: 'type="submit"' })}
		<p class="muted">${signup ? 'Have an account? <a href="/login">Sign in</a>' : 'New here? <a href="/signup">Create an account</a>'}</p>
	</form>
</main>`;
	return htmlDocument(signup ? "Create account · Golem" : "Sign in · Golem", body);
}

export function newWorkspacePage(context: ShellContext, error: string | null): string {
	return shell(context, {
		title: "New workspace",
		header: "New workspace",
		main: `<div class="page">
			<section class="page-section">
				${banner(error)}
				<p>Each workspace has its own channels, threads, members, and integrations.</p>
				<form class="form-row" method="post" action="/workspaces">
					${field("Name", '<input class="input" name="name" placeholder="Family" required autofocus>')}
					${button("Create workspace", { variant: "primary", attributes: 'type="submit"' })}
				</form>
			</section>
		</div>`,
	});
}

export function channelPage(context: ShellContext, channel: Channel, error: string | null): string {
	const workspaceId = context.workspace!.id;
	const threads = channel.threads.length
		? `<div class="list">${channel.threads.map((thread) => threadRow(workspaceId, thread)).join("")}</div>`
		: empty("compose", "No threads yet");
	return shell(context, {
		title: `#${channel.name}`,
		header: `<span class="breadcrumb"># </span>${escape(channel.name)}`,
		main: `<div class="transcript">${banner(error)}${threads}</div>
			${composer(`Start a thread in #${channel.name}`, { post: `/w/${workspaceId}/c/${channel.id}/threads` })}`,
	});
}

function threadRow(workspaceId: string, thread: ThreadSummary): string {
	const time = new Date(thread.updatedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
	return `<a class="list-row" href="/w/${workspaceId}/t/${thread.id}">${icon("compose")}${escape(thread.title)}<span class="meta">${time}</span></a>`;
}

export function threadPage(context: ShellContext, channel: Channel, thread: ThreadSummary): string {
	const base = `/w/${context.workspace!.id}/t/${thread.id}`;
	return shell(context, {
		title: thread.title,
		header: `<span class="breadcrumb">${escape(channel.name)} › </span>${escape(thread.title)}`,
		main: `<section id="transcript" class="transcript" aria-live="polite"></section>
			${composer(`Message #${channel.name}`, `@post('${base}/messages')`)}`,
		artifacts: true,
		init: `@get('${base}/events')`,
	});
}

export function workspaceSettingsPage(
	context: ShellContext,
	members: readonly Member[],
	integrations: readonly Integration[],
	error: string | null,
): string {
	const base = `/w/${context.workspace!.id}`;
	const memberRows = members
		.map(
			(member) =>
				`<div class="list-row"><span class="avatar small" aria-hidden="true">${escape(member.name.slice(0, 1).toUpperCase())}</span>${escape(member.name)}<span class="meta">${escape(member.email)} · ${member.role}</span></div>`,
		)
		.join("");
	const main = `<div class="page">
		${banner(error)}
		<section class="page-section">
			<h2>Members</h2>
			<div class="card"><div class="list">${memberRows}</div>
				<form class="form-row" method="post" action="${base}/members">
					${field("Add someone who has an account", '<input class="input" name="email" type="email" placeholder="name@example.com" required>')}
					${button("Add member", { attributes: 'type="submit"' })}
				</form>
			</div>
		</section>
		<section class="page-section">
			<h2>Integrations</h2>
			<p>Turn on the integrations your agents may use in this workspace. A credential is yours alone, or shared with every agent in the workspace.</p>
			${integrations.map((integration) => integrationCard(base, integration)).join("")}
		</section>
	</div>`;
	return shell({ ...context, current: { page: "workspace-settings" } }, { title: "Workspace settings", header: `${escape(context.workspace!.name)} settings`, main });
}

function integrationCard(base: string, integration: Integration): string {
	const credentials = integration.credentials
		.map(
			(credential) => `<div class="list-row">${icon("settings")}${escape(credential.label)}
				${credential.shared ? badge("Shared with workspace", "accent") : badge("Only me")}
				<span class="meta">${escape(credential.ownerName)}</span>
				${credential.mine ? `<form method="post" action="${base}/credentials/${credential.id}/delete">${button("Delete", { variant: "ghost", small: true, attributes: 'type="submit"' })}</form>` : ""}
			</div>`,
		)
		.join("");
	return `<div class="card">
		<div class="card-header">${escape(integration.name)}${integration.enabled ? badge("On", "success") : badge("Off")}<span class="spacer"></span>
			<form method="post" action="${base}/integrations/${integration.id}">
				<input type="hidden" name="enabled" value="${integration.enabled ? "false" : "true"}">
				${button(integration.enabled ? "Turn off" : "Turn on", { variant: integration.enabled ? undefined : "primary", small: true, attributes: 'type="submit"' })}
			</form>
		</div>
		${credentials ? `<div class="list">${credentials}</div>` : ""}
		<form class="form-row" method="post" action="${base}/integrations/${integration.id}/credentials">
			${field("Label", '<input class="input" name="label" placeholder="Family account" required>')}
			${field(escape(integration.secretLabel), '<input class="input" name="secret" type="password" autocomplete="off" required>')}
			<label class="check"><input type="checkbox" name="shared" value="true">Share with all agents in this workspace</label>
			${button("Add credential", { attributes: 'type="submit"' })}
		</form>
	</div>`;
}

export function settingsPage(context: ShellContext, llm: LlmStatus, error: string | null): string {
	const main = `<div class="page">
		${banner(error)}
		<section class="page-section">
			<h2>LLM provider</h2>
			<p>Every workspace's agents use this provider.</p>
			${llmCard(llm)}
		</section>
		<section class="page-section">
			<h2>Account</h2>
			<div class="card">
				<div class="list-row"><span class="avatar small" aria-hidden="true">${escape(context.user.name.slice(0, 1).toUpperCase())}</span>${escape(context.user.name)}<span class="meta">${escape(context.user.email)}</span></div>
				<form method="post" action="/logout">${button("Sign out", { small: true, attributes: 'type="submit"' })}</form>
			</div>
		</section>
	</div>`;
	return shell({ ...context, current: { page: "settings" } }, { title: "Settings", header: "Settings", main });
}

/** The LLM provider card. While a device login waits, it refreshes itself every 2 seconds. */
export function llmCard(llm: LlmStatus): string {
	const polling = llm.login ? ` data-on-interval__duration.2s="@get('/settings/llm')"` : "";
	const login = llm.login
		? `<p>Open <a href="${escape(llm.login.verificationUri)}" target="_blank" rel="noopener">${escape(llm.login.verificationUri)}</a> and enter this code:</p>
			<p class="code">${escape(llm.login.userCode)}</p>`
		: "";
	const status = llm.connected ? badge(`Connected to ${llm.provider}`, "success") : badge("Not connected", "warning");
	const action = llm.connected
		? `<form method="post" action="/settings/llm/logout">${button("Disconnect", { small: true, attributes: 'type="submit"' })}</form>`
		: llm.login
			? ""
			: `<form method="post" action="/settings/llm/login">${button(`Connect ${llm.provider}`, { variant: "primary", small: true, attributes: 'type="submit"' })}</form>`;
	const models = llm.models
		.map((model) => `<option value="${escape(model)}"${model === llm.model ? " selected" : ""}>${escape(model)}</option>`)
		.join("");
	return `<div id="llm" class="card"${polling}>
		<div class="card-header">${escape(llm.provider)} ${status}<span class="spacer"></span>${action}</div>
		${banner(llm.error)}
		${login}
		<form class="form-row" method="post" action="/settings/llm/model">
			${field("Model", `<select class="input" name="model">${models}</select>`)}
			${button("Save", { small: true, attributes: 'type="submit"' })}
		</form>
	</div>`;
}

function field(label: string, control: string): string {
	return `<label class="field">${label}${control}</label>`;
}

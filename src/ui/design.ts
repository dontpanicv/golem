import tokens from "../../design/tokens.json";
import {
	avatar,
	badge,
	button,
	checkbox,
	composer,
	dialog,
	empty,
	htmlDocument,
	menu,
	message,
	navItem,
	select,
	settingsCard,
	settingsRow,
	textField,
} from "./components.ts";
import { type IconName, icon } from "./icons.ts";

const sampleTime = Date.UTC(2026, 9, 25, 9, 41);

/** Every token and component on one page, in light or dark. Open `/design`. */
export function designPage(): string {
	const theme = (label: string, expression: string) =>
		button(label, { size: "small", attributes: `type="button" data-on:click="${expression}"` });
	const body = `<main class="design">
	<header class="row">
		<h1 style="flex: 1">Golem design system</h1>
		${theme("Light", "document.documentElement.dataset.theme = 'light'")}
		${theme("Dark", "document.documentElement.dataset.theme = 'dark'")}
		${theme("System", "delete document.documentElement.dataset.theme")}
	</header>

	${section("Color", `<div class="grid">${Object.entries(tokens.color).map(([name, value]) => swatch(name, value)).join("")}</div>`)}

	${section(
		"Type",
		`<div style="display: flex; flex-direction: column; gap: var(--space-lg)">${Object.entries(tokens.fontSize)
			.map(
				([name, size]) =>
					`<div class="row"><code style="width: 80px">${name} · ${size}</code><span style="font-size: ${size}px; font-weight: var(--font-weight-medium)">Golem keeps the family organized</span></div>`,
			)
			.join("")}</div>`,
	)}

	${section(
		"Buttons",
		`<div class="row">
			${button("Primary", { variant: "primary" })}
			${button("Secondary")}
			${button("Ghost", { variant: "ghost" })}
			${button("Danger", { variant: "danger" })}
			${button("With icon", { icon: "plus" })}
			${button("Disabled", { attributes: 'type="button" disabled' })}
		</div>
		<div class="row" style="margin-top: var(--space-lg)">
			${button("Small", { size: "small" })}
			${button("Small primary", { variant: "primary", size: "small" })}
			${button("Search", { variant: "ghost", icon: "search", size: "icon", shortcut: "/" })}
			${button("New thread", { icon: "compose", size: "icon" })}
			${button("Send", { variant: "primary", icon: "send", size: "tiny", round: true })}
			<div style="width: 320px">${button("Large", { variant: "primary", size: "large" })}</div>
		</div>`,
	)}

	${section(
		"Fields and selects",
		`<div class="row" style="align-items: end">
			<div style="width: 240px">${textField("Name", { name: "name", placeholder: "Family" })}</div>
			${select({ name: "model", label: "Model", value: "gpt-6.1-sol", options: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra"].map((value) => ({ value, label: value })) })}
			${menu(
				button("Open menu", { icon: "more", attributes: 'type="button" data-popover-trigger aria-haspopup="menu" aria-expanded="false"' }),
				[
					{ kind: "label", label: "Thread" },
					{ kind: "action", label: "Rename", icon: "compose", attributes: 'type="button"' },
					{ kind: "action", label: "Copy link", icon: "attach", attributes: 'type="button"' },
					{ kind: "separator" },
					{ kind: "action", label: "Delete", icon: "trash", attributes: 'type="button"' },
				],
			)}
		</div>`,
	)}

	${section(
		"Switches and checkboxes",
		`<div class="row">
			<input class="switch" type="checkbox" role="switch" aria-label="Off">
			<input class="switch" type="checkbox" role="switch" aria-label="On" checked>
			<input class="switch" type="checkbox" role="switch" aria-label="Disabled" disabled>
			${checkbox("Share with all agents in this workspace", { name: "shared" })}
			${checkbox("Checked", { name: "checked", checked: true })}
		</div>`,
	)}

	${section(
		"Badges, keys, and avatars",
		`<div class="row">
			${badge("Running", "accent")} ${badge("Done", "success")} ${badge("Waiting", "warning")} ${badge("Failed", "danger")} ${badge("Draft")}
			<span class="kbd">⌘</span><span class="kbd">K</span>
			${avatar("Anna")} ${avatar("Golem", { agent: true })} ${avatar("Golem", { agent: true, size: "large" })}
		</div>`,
	)}

	${section(
		"Dialogs and toasts",
		`<div class="row">
			${button("Open dialog", { attributes: 'type="button" data-dialog-open="design-dialog"' })}
			${button("Show toast", { attributes: `type="button" data-on:click="document.querySelector('.toasts').insertAdjacentHTML('beforeend', '<div class=&quot;toast success&quot; data-toast data-state=&quot;open&quot;><span class=&quot;dot&quot;></span>Credential added</div>')"` })}
		</div>
		${dialog("design-dialog", {
			title: "Add a GitHub credential",
			action: "#",
			submit: "Add credential",
			body: `${textField("Label", { name: "label", placeholder: "Family account" })}${textField("Personal access token", { name: "secret", type: "password" })}${checkbox("Share with all agents in this workspace", { name: "shared" })}`,
		})}`,
	)}

	${section(
		"Settings",
		settingsCard([
			settingsRow("ChatGPT", "Connected. Every workspace's agents use it.", `${badge("Connected", "success")}${button("Disconnect")}`),
			settingsRow("Model", "Used by every thread.", select({ name: "model", label: "Model", value: "gpt-6.1-sol", options: [{ value: "gpt-6.1-sol", label: "gpt-6.1-sol" }, { value: "gpt-6-sol", label: "gpt-6-sol" }] })),
			settingsRow("GitHub", "1 credential · Personal access token", '<input class="switch" type="checkbox" role="switch" aria-label="Use GitHub" checked>'),
		]),
	)}

	${section(
		"Icons",
		`<div class="row" style="color: var(--color-text-secondary)">${(["hash", "plus", "search", "compose", "sidebar", "panel", "send", "attach", "file", "artifact", "preview", "chevron", "inbox", "settings", "members", "check", "close", "trash", "key", "logout", "more"] as IconName[])
			.map((name) => `<span data-tooltip="${name}">${icon(name)}</span>`)
			.join("")}</div>`,
	)}

	${section(
		"Navigation",
		`<div class="card" style="width: var(--size-sidebar); background: var(--color-canvas)"><nav class="nav">
			${navItem("Inbox", { icon: "inbox", href: "#", count: 3 })}
			<div class="nav-section">Channels</div>
			${navItem("family", { icon: "hash", href: "#" })}
			<div class="nav-threads">${navItem("Weekend plans", { icon: "compose", href: "#", current: true })}${navItem("School forms", { icon: "compose", href: "#" })}</div>
			${navItem("finances", { icon: "hash", href: "#" })}
		</nav></div>`,
	)}

	${section(
		"Conversation",
		`<div class="card" style="padding: 0; background: var(--color-surface)">
			<div class="transcript">
				${message({ author: "Anna", agent: false, text: "Can you find a free Saturday for the cabin trip?", time: sampleTime })}
				${message({ author: "Golem", agent: true, text: "Saturday 8 November is free for everyone. I drafted a calendar event and a packing list.", time: sampleTime + 60_000 })}
				${message({ author: "Golem", agent: true, text: "Calendar access expired. Reconnect Google to continue.", time: sampleTime + 120_000, failed: true })}
			</div>
			${composer("Message family", "")}
		</div>`,
	)}

	${section("Empty state", `<div class="card">${empty("artifact", "No artifacts yet")}</div>`)}
</main>`;
	return htmlDocument("Design system · Golem", body);
}

function section(title: string, content: string): string {
	return `<section><h2>${title}</h2>${content}</section>`;
}

function swatch(name: string, value: { light: string; dark: string }): string {
	const variable = `--color-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
	return `<div class="swatch"><div class="swatch-color" style="background: var(${variable})"></div>${name}<code>${value.light} · ${value.dark}</code></div>`;
}

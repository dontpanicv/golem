import tokens from "../../design/tokens.json";
import { badge, button, composer, empty, htmlDocument, message, navItem } from "./components.ts";
import { icon, type IconName } from "./icons.ts";

const sampleTime = Date.UTC(2026, 9, 25, 9, 41);

/** Every token and component on one page, in light or dark. Open `/design`. */
export function designPage(): string {
	const body = `<main class="design">
	<header class="row">
		<h1 style="flex: 1">Golem design system</h1>
		${button("Light", { small: true, attributes: `type="button" data-on:click="document.documentElement.dataset.theme = 'light'"` })}
		${button("Dark", { small: true, attributes: `type="button" data-on:click="document.documentElement.dataset.theme = 'dark'"` })}
		${button("System", { small: true, attributes: `type="button" data-on:click="delete document.documentElement.dataset.theme"` })}
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
		"Space and radius",
		`<div class="row">${Object.entries(tokens.space)
			.map(([name, size]) => `<div class="swatch"><div style="width: ${size}px; height: 24px; background: var(--color-accent); border-radius: 2px"></div><code>${name} · ${size}</code></div>`)
			.join("")}</div>
		<div class="row" style="margin-top: var(--space-xl)">${Object.entries(tokens.radius)
			.map(([name, radius]) => `<div class="swatch"><div class="swatch-color" style="width: 64px; border-radius: ${Math.min(radius, 32)}px; background: var(--color-surface-raised)"></div><code>${name} · ${radius}</code></div>`)
			.join("")}</div>`,
	)}

	${section(
		"Buttons",
		`<div class="row">
			${button("Primary", { variant: "primary" })}
			${button("Secondary")}
			${button("Ghost", { variant: "ghost" })}
			${button("With icon", { icon: "plus" })}
			${button("Disabled", { attributes: 'type="button" disabled' })}
			${button("Small", { small: true })}
			${button("New thread", { icon: "compose", iconOnly: true, round: true, small: true })}
			${button("Send", { variant: "primary", icon: "send", iconOnly: true, round: true, small: true })}
		</div>`,
	)}

	${section(
		"Inputs and badges",
		`<div class="row">
			<input class="input" placeholder="Search threads" aria-label="Search threads">
			${badge("Running", "accent")} ${badge("Done", "success")} ${badge("Waiting", "warning")} ${badge("Failed", "danger")} ${badge("Draft")}
			<span class="kbd">⌘</span><span class="kbd">K</span>
		</div>`,
	)}

	${section(
		"Icons",
		`<div class="row" style="color: var(--color-text-secondary)">${(["hash", "plus", "search", "compose", "sidebar", "panel", "send", "attach", "file", "artifact", "preview", "chevron", "inbox", "more"] as IconName[])
			.map((name) => `<span title="${name}">${icon(name)}</span>`)
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

	${section(
		"Lists and panels",
		`<div class="row" style="align-items: stretch">
			<div class="card" style="flex: 1; padding: var(--space-md)">
				<div class="group-header">${icon("artifact")}Artifacts</div>
				<div class="list">
					<div class="list-row">${icon("file")}Packing list.md<span class="meta">2 min</span></div>
					<div class="list-row">${icon("preview")}Cabin booking page<span class="meta">5 min</span></div>
				</div>
			</div>
			<div class="card" style="flex: 1; display: flex">${empty("artifact", "No artifacts yet")}</div>
		</div>`,
	)}
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

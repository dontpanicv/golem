import { type IconName, icon } from "./icons.ts";

// Server-rendered components. Looks are in public/styles.css, behaviors in public/ui.js,
// and the spec for each is in design/components.md.

const escape = Bun.escapeHTML;

export type Message = {
	readonly author: string;
	readonly agent: boolean;
	readonly text: string;
	readonly time: number;
	readonly failed?: boolean;
	readonly streaming?: boolean;
};

export type Toast = { readonly tone: "error" | "success"; readonly text: string } | null;

export function htmlDocument(title: string, body: string, bodyAttributes = "", toast: Toast = null): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escape(title)}</title>
	<link rel="icon" href="/assets/icon.png" type="image/png">
	<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
	<link rel="preload" href="/assets/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin>
	<link rel="stylesheet" href="/assets/tokens.css">
	<link rel="stylesheet" href="/assets/styles.css">
	<script type="module" src="/assets/datastar.js"></script>
	<script type="module" src="/assets/ui.js"></script>
</head>
<body ${bodyAttributes}>
${body}
<div class="toasts" aria-live="polite">${toast ? `<div class="toast ${toast.tone}" role="status" data-toast><span class="dot"></span>${escape(toast.text)}</div>` : ""}</div>
</body>
</html>`;
}

export type ButtonOptions = {
	readonly variant?: "primary" | "ghost" | "danger";
	readonly size?: "small" | "large" | "icon" | "tiny";
	readonly icon?: IconName;
	readonly round?: boolean;
	/** Shortcut shown in the tooltip of an icon button. */
	readonly shortcut?: string;
	/** Raw attributes; defaults to `type="button"`. */
	readonly attributes?: string;
};

/** A button. Icon buttons carry their label as an accessible name and a tooltip. */
export function button(label: string, options: ButtonOptions = {}): string {
	const iconOnly = options.size === "icon" || options.size === "tiny";
	const classes = ["button", options.variant, iconOnly ? "icon-only" : options.size, options.size === "tiny" && "tiny", options.round && "round"];
	const content = iconOnly ? icon(options.icon!) : `${options.icon ? icon(options.icon) : ""}${escape(label)}`;
	const name = iconOnly
		? ` aria-label="${escape(label)}" data-tooltip="${escape(label)}"${options.shortcut ? ` data-shortcut="${escape(options.shortcut)}"` : ""}`
		: "";
	return `<button class="${classes.filter(Boolean).join(" ")}"${name} ${options.attributes ?? 'type="button"'}>${content}</button>`;
}

export function navItem(label: string, options: { icon: IconName; href: string; current?: boolean; count?: number }): string {
	const current = options.current ? ' aria-current="page"' : "";
	const count = options.count ? `<span class="count">${options.count}</span>` : "";
	return `<a class="nav-item" href="${escape(options.href)}"${current}>${icon(options.icon)}<span class="label">${escape(label)}</span>${count}</a>`;
}

export function avatar(name: string, options: { agent?: boolean; size?: "small" | "large" } = {}): string {
	const classes = ["avatar", options.agent && "agent", options.size].filter(Boolean).join(" ");
	return `<span class="${classes}" aria-hidden="true">${escape(name.slice(0, 1).toUpperCase())}</span>`;
}

export function message(m: Message): string {
	const time = new Date(m.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	const classes = ["message", m.failed && "failed", m.streaming && "streaming"].filter(Boolean).join(" ");
	return `<article class="${classes}">
	${avatar(m.author, { agent: m.agent })}
	<div class="message-body">
		<div class="message-meta"><span class="message-author">${escape(m.author)}</span><time class="message-time">${time}</time></div>
		<p class="message-text">${escape(m.text)}</p>
	</div>
</article>`;
}

/** A message box. `action` is a Datastar expression, or `{ post }` for a plain form that posts `text`. */
export function composer(placeholder: string, action: string | { post: string }): string {
	const form =
		typeof action === "string"
			? `<form class="composer" data-on:submit__prevent="${action}">`
			: `<form class="composer" method="post" action="${escape(action.post)}">`;
	const binding = typeof action === "string" ? "data-bind:message" : 'name="text" required';
	// Enter sends; Shift+Enter adds a line.
	return `${form}
	<textarea ${binding} rows="1" placeholder="${escape(placeholder)}" aria-label="Message" data-on:keydown="evt.key === 'Enter' &amp;&amp; !evt.shiftKey &amp;&amp; (evt.preventDefault(), el.form.requestSubmit())"></textarea>
	<div class="composer-actions">
		${button("Attach file", { variant: "ghost", icon: "attach", size: "icon" })}
		<span class="spacer"></span>
		${button("Send", { variant: "primary", icon: "send", size: "tiny", round: true, shortcut: "↵", attributes: 'type="submit"' })}
	</div>
</form>`;
}

export function empty(iconName: IconName, title: string): string {
	return `<div class="empty">${icon(iconName)}<strong>${escape(title)}</strong></div>`;
}

export function badge(label: string, tone?: "success" | "warning" | "danger" | "accent"): string {
	return `<span class="badge${tone ? ` ${tone}` : ""}"><span class="dot"></span>${escape(label)}</span>`;
}

export function textField(label: string, input: { name: string; type?: string; placeholder?: string; value?: string; required?: boolean; autocomplete?: string; large?: boolean; autofocus?: boolean }): string {
	const attributes = [
		`class="input${input.large ? " large" : ""}"`,
		`name="${escape(input.name)}"`,
		`type="${input.type ?? "text"}"`,
		input.placeholder && `placeholder="${escape(input.placeholder)}"`,
		input.value && `value="${escape(input.value)}"`,
		input.autocomplete && `autocomplete="${input.autocomplete}"`,
		input.required && "required",
		input.autofocus && "autofocus",
	];
	return `<label class="field">${escape(label)}<input ${attributes.filter(Boolean).join(" ")}></label>`;
}

/** Our select: a trigger and a menu of options; `autosubmit` submits the form when the value changes. */
export function select(options: {
	name: string;
	label: string;
	value: string;
	options: readonly { value: string; label: string }[];
	autosubmit?: boolean;
}): string {
	const current = options.options.find((option) => option.value === options.value) ?? options.options[0];
	const items = options.options
		.map(
			(option) =>
				`<div class="menu-item" role="option" data-value="${escape(option.value)}" aria-selected="${option.value === current?.value}"><span class="label">${escape(option.label)}</span><span class="check">${icon("check")}</span></div>`,
		)
		.join("");
	return `<div class="popover" data-popover${options.autosubmit ? " data-autosubmit" : ""}>
	<button type="button" class="select-trigger" data-popover-trigger aria-haspopup="listbox" aria-expanded="false" aria-label="${escape(options.label)}"><span data-popover-value>${escape(current?.label ?? "")}</span>${icon("chevron")}</button>
	<div class="menu" role="listbox" tabindex="-1" hidden>${items}</div>
	<input type="hidden" name="${escape(options.name)}" value="${escape(current?.value ?? "")}">
</div>`;
}

export type MenuEntry =
	| { readonly kind: "link"; readonly label: string; readonly href: string; readonly icon?: IconName; readonly current?: boolean }
	| { readonly kind: "action"; readonly label: string; readonly attributes: string; readonly icon?: IconName }
	| { readonly kind: "separator" }
	| { readonly kind: "label"; readonly label: string };

/** An action menu opened by `trigger`, which must be a button with the `data-popover-trigger` attribute. */
export function menu(trigger: string, entries: readonly MenuEntry[], align: "start" | "end" = "end"): string {
	const items = entries
		.map((entry) => {
			if (entry.kind === "separator") return '<div class="menu-separator" role="separator"></div>';
			if (entry.kind === "label") return `<div class="menu-label">${escape(entry.label)}</div>`;
			const inner = `${entry.icon ? icon(entry.icon) : ""}<span class="label">${escape(entry.label)}</span><span class="check">${icon("check")}</span>`;
			return entry.kind === "link"
				? `<a class="menu-item" role="menuitem" href="${escape(entry.href)}"${entry.current ? ' aria-current="true"' : ""}>${inner}</a>`
				: `<button class="menu-item" role="menuitem" ${entry.attributes}>${inner}</button>`;
		})
		.join("");
	return `<div class="popover" data-popover data-align="${align}">${trigger}<div class="menu" role="menu" tabindex="-1" hidden>${items}</div></div>`;
}

/** A switch inside a form of its own that posts `name=true` when on, and nothing when off. */
export function switchForm(action: string, options: { name: string; label: string; checked: boolean }): string {
	return `<form method="post" action="${escape(action)}"><input class="switch" type="checkbox" role="switch" name="${escape(options.name)}" value="true" aria-label="${escape(options.label)}"${options.checked ? " checked" : ""} data-autosubmit></form>`;
}

export function checkbox(label: string, options: { name: string; checked?: boolean }): string {
	return `<label class="check-row"><input class="checkbox" type="checkbox" name="${escape(options.name)}" value="true"${options.checked ? " checked" : ""}>${escape(label)}</label>`;
}

/** A modal dialog with a form. Open it with a button that has `data-dialog-open="<id>"`. */
export function dialog(id: string, options: { title: string; action: string; body: string; submit: string }): string {
	return `<dialog class="dialog" id="${escape(id)}" aria-labelledby="${escape(id)}-title">
	<form method="post" action="${escape(options.action)}">
		<header class="dialog-header"><h2 id="${escape(id)}-title">${escape(options.title)}</h2>${button("Close", { variant: "ghost", icon: "close", size: "icon", attributes: 'type="button" data-dialog-close' })}</header>
		<div class="dialog-body">${options.body}</div>
		<footer class="dialog-footer">${button("Cancel", { attributes: 'type="button" data-dialog-close' })}${button(options.submit, { variant: "primary", attributes: 'type="submit"' })}</footer>
	</form>
</dialog>`;
}

export function settingsCard(rows: readonly string[], attributes = ""): string {
	return `<div class="settings-card"${attributes ? ` ${attributes}` : ""}>${rows.join("")}</div>`;
}

/** A settings row: label and description on the left, `control` on the right. */
export function settingsRow(label: string, description: string | null, control: string, options: { lead?: string; compact?: boolean } = {}): string {
	return `<div class="settings-row${options.compact ? " compact" : ""}">${options.lead ?? ""}<div class="settings-text"><strong>${escape(label)}</strong>${description ? `<span>${escape(description)}</span>` : ""}</div>${control}</div>`;
}

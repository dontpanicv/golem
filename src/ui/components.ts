import { type IconName, icon } from "./icons.ts";

const escape = Bun.escapeHTML;

export type Message = {
	readonly author: string;
	readonly agent: boolean;
	readonly text: string;
	readonly time: number;
	readonly failed?: boolean;
	readonly streaming?: boolean;
};

export function htmlDocument(title: string, body: string, bodyAttributes = ""): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escape(title)}</title>
	<link rel="preload" href="/assets/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin>
	<link rel="stylesheet" href="/assets/tokens.css">
	<link rel="stylesheet" href="/assets/styles.css">
	<script type="module" src="/assets/datastar.js"></script>
</head>
<body ${bodyAttributes}>
${body}
</body>
</html>`;
}

export function button(
	label: string,
	options: { variant?: "primary" | "ghost"; icon?: IconName; iconOnly?: boolean; small?: boolean; round?: boolean; attributes?: string } = {},
): string {
	const classes = ["button", options.variant, options.iconOnly && "icon-only", options.small && "small", options.round && "round"];
	const content = options.iconOnly ? icon(options.icon!) : `${options.icon ? icon(options.icon) : ""}${escape(label)}`;
	const name = options.iconOnly ? ` aria-label="${escape(label)}" title="${escape(label)}"` : "";
	return `<button class="${classes.filter(Boolean).join(" ")}"${name} ${options.attributes ?? 'type="button"'}>${content}</button>`;
}

export function navItem(label: string, options: { icon: IconName; href: string; current?: boolean; count?: number }): string {
	const current = options.current ? ' aria-current="page"' : "";
	const count = options.count ? `<span class="count">${options.count}</span>` : "";
	return `<a class="nav-item" href="${escape(options.href)}"${current}>${icon(options.icon)}<span class="label">${escape(label)}</span>${count}</a>`;
}

export function avatar(name: string, agent = false): string {
	return `<span class="avatar${agent ? " agent" : ""}" aria-hidden="true">${escape(name.slice(0, 1).toUpperCase())}</span>`;
}

export function message(m: Message): string {
	const time = new Date(m.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	const classes = ["message", m.failed && "failed", m.streaming && "streaming"].filter(Boolean).join(" ");
	return `<article class="${classes}">
	${avatar(m.author, m.agent)}
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
		${button("Attach file", { variant: "ghost", icon: "attach", iconOnly: true, small: true })}
		<span class="spacer"></span>
		${button("Send", { variant: "primary", icon: "send", iconOnly: true, small: true, round: true, attributes: 'type="submit"' })}
	</div>
</form>`;
}

export function banner(error: string | null | undefined): string {
	return error ? `<p class="banner" role="alert">${escape(error)}</p>` : "";
}

export function empty(iconName: IconName, title: string): string {
	return `<div class="empty">${icon(iconName)}<strong>${escape(title)}</strong></div>`;
}

export function badge(label: string, tone?: "success" | "warning" | "danger" | "accent"): string {
	return `<span class="badge${tone ? ` ${tone}` : ""}"><span class="dot"></span>${escape(label)}</span>`;
}

import { readFileSync } from "node:fs";
import { type IconName, icon } from "./icons.ts";
import { markdown } from "./markdown.ts";

// Server-rendered components. Looks are in public/styles.css, behaviors in public/ui.js,
// and the spec for each is in design/components.md.

const escapeHtml = Bun.escapeHTML;

export interface Message {
  readonly id: string;
  readonly author: string;
  readonly agent: boolean;
  readonly text: string;
  readonly time: number;
  readonly failed?: boolean;
  readonly streaming?: boolean;
  readonly files?: readonly { readonly id: string; readonly name: string }[];
  readonly work?: Work | null;
}

/** What an agent did before its answer. `endedAt` is null while it works. */
export interface Work {
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopped: boolean;
  readonly steps: readonly {
    readonly kind: "thinking" | "text" | "tool";
    readonly text: string;
    readonly tool: string | null;
    readonly input: string | null;
    readonly output: string | null;
    readonly running: boolean;
    readonly failed: boolean;
  }[];
}

export type Toast = {
  readonly tone: "error" | "success";
  readonly text: string;
} | null;

const PUBLIC_DIRECTORY = new URL("../../../public/", import.meta.url);

/** The address of a file in `public/` with a hash of its content, so browsers keep it until it changes. */
function asset(path: string): string {
  const hash = Bun.hash(readFileSync(new URL(path, PUBLIC_DIRECTORY)));
  return `/assets/${path}?v=${hash.toString(36)}`;
}

export function htmlDocument(
  title: string,
  body: string,
  bodyAttributes = "",
  toast: Toast = null
): string {
  return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escapeHtml(title)}</title>
	<link rel="icon" href="/assets/icon.png" type="image/png">
	<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
	<link rel="preload" href="/assets/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin>
	<link rel="stylesheet" href="${asset("tokens.css")}">
	<link rel="stylesheet" href="${asset("styles.css")}">
	<script type="module" src="${asset("datastar.js")}"></script>
	<script type="module" src="${asset("ui.js")}"></script>
</head>
<body ${bodyAttributes}>
${body}
<div class="toasts" aria-live="polite">${toast ? toastCard(toast) : ""}</div>
</body>
</html>`;
}

/** A toast; ui.js builds the same markup for the toasts it shows. */
function toastCard(toast: NonNullable<Toast>): string {
  return `<div class="toast ${toast.tone}" role="status" data-toast><span class="toast-icon"></span><span class="toast-text">${escapeHtml(toast.text)}</span><button type="button" class="toast-close" aria-label="Dismiss"></button></div>`;
}

export interface ButtonOptions {
  readonly variant?: "primary" | "ghost" | "danger";
  readonly size?: "small" | "large" | "icon" | "tiny";
  readonly icon?: IconName;
  /** Shortcut shown in the tooltip of an icon button. */
  readonly shortcut?: string;
  /** Raw attributes; defaults to `type="button"`. */
  readonly attributes?: string;
}

/** A button. Icon buttons carry their label as an accessible name and a tooltip. */
export function button(label: string, options: ButtonOptions = {}): string {
  const iconOnly = options.size === "icon" || options.size === "tiny";
  const classes = [
    "button",
    options.variant,
    iconOnly ? "icon-only" : options.size,
    options.size === "tiny" && "tiny",
  ];
  const content = iconOnly
    ? icon(options.icon!)
    : `${options.icon ? icon(options.icon) : ""}${escapeHtml(label)}`;
  const name = iconOnly
    ? ` aria-label="${escapeHtml(label)}" data-tooltip="${escapeHtml(label)}"${options.shortcut ? ` data-shortcut="${escapeHtml(options.shortcut)}"` : ""}`
    : "";
  return `<button class="${classes.filter(Boolean).join(" ")}"${name} ${options.attributes ?? 'type="button"'}>${content}</button>`;
}

export function navItem(
  label: string,
  options: {
    icon: IconName;
    href: string;
    current?: boolean;
    count?: number;
    /** A thread whose spinner shows while its agent works. */
    threadId?: string;
  }
): string {
  const current = options.current ? ' aria-current="page"' : "";
  const count = options.count
    ? `<span class="count">${options.count}</span>`
    : "";
  const working = options.threadId ? workingSpinner(options.threadId) : "";
  return `<a class="nav-item" href="${escapeHtml(options.href)}"${current}>${icon(options.icon)}<span class="label">${escapeHtml(label)}</span>${working}${count}</a>`;
}

/** The key in the `working` signal that is true while the agent of a thread works; signal keys cannot hold dashes. */
export function workingKey(threadId: string): string {
  return `t${threadId.replaceAll("-", "")}`;
}

/** A spinner that shows while the agent of a thread works. The workspace's working stream sets `working`. */
export function workingSpinner(threadId: string): string {
  return `<span class="working-spinner" data-show="$working.${workingKey(escapeHtml(threadId))}" style="display: none" role="img" aria-label="Working"></span>`;
}

/** The number of colors in `avatar` of design/tokens.json. */
const AVATAR_COLORS = 10;

/** The avatar color of a name: the sum of its code points, as iOS's `Avatar` picks it too. */
function avatarColor(name: string): number {
  let sum = 0;
  for (const character of name) {
    sum += character.codePointAt(0)!;
  }
  return sum % AVATAR_COLORS;
}

/** A person's initial on a color picked by their name, or an agent's on the accent. */
export function avatar(
  name: string,
  options: { agent?: boolean; size?: "small" | "large" } = {}
): string {
  const classes = ["avatar", options.agent && "agent", options.size]
    .filter(Boolean)
    .join(" ");
  const color = options.agent
    ? ""
    : ` style="--avatar: var(--avatar-${avatarColor(name)})"`;
  return `<span class="${classes}"${color} aria-hidden="true">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
}

/** A link to a thread as agents write it in messages: `[title](thread:<id>)`. */
const THREAD_LINK = /\[([^\]\n]+)\]\(thread:([\w-]+)\)/g;

/** A message; each thread link in its text opens `threadHref(threadId)`, each attached file `fileHref(fileId)`. */
export function message(
  m: Message,
  threadHref: (threadId: string) => string,
  fileHref: (fileId: string) => string
): string {
  const time = new Date(m.time).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const linked = (text: string) =>
    escapeHtml(text).replace(
      THREAD_LINK,
      (_, title: string, threadId: string) =>
        `<a class="thread-link" href="${escapeHtml(threadHref(threadId))}">${title}</a>${workingSpinner(threadId)}`
    );
  const classes = ["message", m.failed && "failed", m.streaming && "streaming"]
    .filter(Boolean)
    .join(" ");
  return `<article class="${classes}">
	${avatar(m.author, { agent: m.agent })}
	<div class="message-body">
		<div class="message-meta"><span class="message-author">${escapeHtml(m.author)}</span><time class="message-time">${time}</time></div>
		${m.work ? workLog(m.id, m.work, linked) : ""}
		${m.text ? messageText(m, linked, threadHref, fileHref) : ""}
		${m.files?.length ? `<div class="file-chips">${m.files.map((file) => fileChip(file.name, { href: fileHref(file.id) })).join("")}</div>` : ""}
	</div>
</article>`;
}

/** An agent's answer in Markdown; a person's message and an error as they are written. */
function messageText(
  m: Message,
  linked: (text: string) => string,
  threadHref: (threadId: string) => string,
  fileHref: (fileId: string) => string
): string {
  if (!m.agent || m.failed) {
    return `<p class="message-text">${linked(m.text)}</p>`;
  }
  const html = markdown(m.text, {
    thread: threadHref,
    file: fileHref,
    afterThread: workingSpinner,
  });
  return `<div class="message-text prose">${html}</div>`;
}

/**
 * The work before an answer: open while the agent works, then folded into "Worked for …". The person's choice to open
 * or fold it survives the transcript's patches; the fold gets a new id when the work ends, so it then folds. Calls of
 * one tool in a row fold into one row, and each tool call opens to show its arguments and result.
 */
function workLog(
  messageId: string,
  work: Work,
  linked: (text: string) => string
): string {
  const working = work.endedAt === null;
  const id = `work-${escapeHtml(messageId)}${working ? "-live" : ""}`;
  const elapsed = duration((work.endedAt ?? Date.now()) - work.startedAt);
  let label = `Worked for ${elapsed}`;
  if (working) {
    label = `Working for <span data-elapsed-since="${work.startedAt}">${elapsed}</span>`;
  } else if (work.stopped) {
    label = `Stopped after ${elapsed}`;
  }
  const steps = runs(work.steps)
    .map(({ start, steps: run }) => {
      if (run.length === 1) {
        return workStep(run[0]!, `${id}-${start}`, linked);
      }
      const rows = run
        .map((step, index) => workStep(step, `${id}-${start + index}`, linked))
        .join("");
      const running = run.some((step) => step.running);
      return `<li><details id="${id}-group-${start}" class="work-group" data-preserve-attr="open"${running ? " open" : ""}><summary class="work-row">${toolName(run[0]!.tool!)}<span class="work-tool-detail">${run.length} times</span></summary><ol class="work-group-steps">${rows}</ol></details></li>`;
    })
    .join("");
  return `<details id="${id}" class="work${working ? " working" : ""}" data-preserve-attr="open"${working ? " open" : ""}><summary class="work-summary"><span>${label}</span>${steps ? `<span class="disclosure">${icon("disclosure")}</span>` : ""}</summary>${steps ? `<ol class="work-steps">${steps}</ol>` : ""}</details>`;
}

type WorkStep = Work["steps"][number];

/** The steps in runs: each call of a tool that the call before it also made joins that call's run. */
function runs(
  steps: readonly WorkStep[]
): { start: number; steps: WorkStep[] }[] {
  const result: { start: number; steps: WorkStep[] }[] = [];
  for (const [index, step] of steps.entries()) {
    const last = result.at(-1);
    if (step.kind === "tool" && last && last.steps[0]!.tool === step.tool) {
      last.steps.push(step);
    } else {
      result.push({ start: index, steps: [step] });
    }
  }
  return result;
}

function workStep(
  step: WorkStep,
  id: string,
  linked: (text: string) => string
): string {
  if (step.kind !== "tool") {
    return `<li class="work-${step.kind}">${linked(step.text)}</li>`;
  }
  const classes = [
    "work-tool",
    step.running && "running",
    step.failed && "failed",
  ]
    .filter(Boolean)
    .join(" ");
  const io = [step.input, step.output]
    .filter((part) => part !== null && part !== "" && part !== "{}")
    .map((part) => `<pre>${escapeHtml(part!)}</pre>`)
    .join("");
  return `<li><details id="${id}" class="${classes}" data-preserve-attr="open"><summary class="work-row">${toolName(step.tool!)}${step.text ? `<span class="work-tool-detail">${linked(step.text)}</span>` : ""}</summary>${io}</details></li>`;
}

/** A tool's name as words: `web_search` is Web search. */
function toolName(tool: string): string {
  const words = tool.replaceAll("_", " ");
  return `<span class="work-tool-name">${escapeHtml(words.charAt(0).toUpperCase() + words.slice(1))}</span>`;
}

/** A time span as 8s, 2m 05s, or 1h 03m. */
function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** An attached file: with `href`, a link that opens it; with `remove`, a picked file with a remove button. */
export function fileChip(
  name: string,
  options: { href?: string; remove?: boolean } = {}
): string {
  const content = `${icon("attach")}<span>${escapeHtml(name)}</span>`;
  if (options.href) {
    return `<a class="file-chip" href="${escapeHtml(options.href)}" target="_blank">${content}</a>`;
  }
  const remove = options.remove
    ? `<button type="button" class="file-chip-remove" aria-label="Remove ${escapeHtml(name)}" data-file-remove>${icon("close")}</button>`
    : "";
  return `<span class="file-chip">${content}${remove}</span>`;
}

/**
 * A message box that posts `text` and the attached `files` as a multipart form. Files are picked, dropped on it, or
 * pasted into it. `action` is a Datastar expression, or `{ post }` for a plain form post. `stop`, a Datastar expression,
 * adds a Stop button that shows while `$running`.
 */
export function composer(
  placeholder: string,
  action: string | { post: string },
  stop?: string
): string {
  const form =
    typeof action === "string"
      ? `<form id="composer" class="composer" data-file-drop enctype="multipart/form-data" data-on:submit__prevent="${action}">`
      : `<form id="composer" class="composer" data-file-drop method="post" enctype="multipart/form-data" action="${escapeHtml(action.post)}">`;
  // Enter sends; Shift+Enter adds a line.
  return `${form}
	<textarea name="text" rows="1" placeholder="${escapeHtml(placeholder)}" aria-label="Message" data-on:keydown="evt.key === 'Enter' &amp;&amp; !evt.shiftKey &amp;&amp; (evt.preventDefault(), el.form.requestSubmit())"></textarea>
	<div class="file-chips" data-file-list hidden></div>
	<template data-file-chip>${fileChip("", { remove: true })}</template>
	<div class="composer-actions">
		${button("Attach file", { variant: "ghost", icon: "attach", size: "tiny", attributes: 'type="button" data-file-pick' })}
		<input type="file" name="files" multiple hidden>
		<span class="spacer"></span>
		${stop ? button("Stop", { icon: "stop", size: "tiny", attributes: `type="button" data-show="$running" style="display: none" data-on:click="${escapeHtml(stop)}"` }) : ""}
		${button("Send", { variant: "primary", icon: "send", size: "tiny", shortcut: "↵", attributes: 'type="submit"' })}
	</div>
</form>`;
}

export function empty(iconName: IconName, title: string): string {
  return `<div class="empty">${icon(iconName)}<strong>${escapeHtml(title)}</strong></div>`;
}

export function badge(
  label: string,
  tone?: "success" | "warning" | "danger" | "accent"
): string {
  return `<span class="badge${tone ? ` ${tone}` : ""}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}

export function textField(
  label: string,
  input: {
    name: string;
    type?: string;
    placeholder?: string;
    value?: string;
    required?: boolean;
    autocomplete?: string;
    large?: boolean;
    autofocus?: boolean;
  }
): string {
  const attributes = [
    `class="input${input.large ? " large" : ""}"`,
    `name="${escapeHtml(input.name)}"`,
    `type="${input.type ?? "text"}"`,
    input.placeholder && `placeholder="${escapeHtml(input.placeholder)}"`,
    input.value && `value="${escapeHtml(input.value)}"`,
    input.autocomplete && `autocomplete="${input.autocomplete}"`,
    input.required && "required",
    input.autofocus && "autofocus",
  ];
  return `<label class="field">${escapeHtml(label)}<input ${attributes.filter(Boolean).join(" ")}></label>`;
}

/** Our select: a trigger and a menu of options; `autosubmit` submits the form when the value changes. */
export function select(options: {
  name: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  autosubmit?: boolean;
}): string {
  const current =
    options.options.find((option) => option.value === options.value) ??
    options.options[0];
  const items = options.options
    .map(
      (option) =>
        `<div class="menu-item" role="option" data-value="${escapeHtml(option.value)}" aria-selected="${option.value === current?.value}"><span class="label">${escapeHtml(option.label)}</span><span class="check">${icon("check")}</span></div>`
    )
    .join("");
  return `<div class="popover" data-popover${options.autosubmit ? " data-autosubmit" : ""}>
	<button type="button" class="select-trigger" data-popover-trigger aria-haspopup="listbox" aria-expanded="false" aria-label="${escapeHtml(options.label)}"><span data-popover-value>${escapeHtml(current?.label ?? "")}</span>${icon("chevron")}</button>
	<div class="menu" role="listbox" tabindex="-1" hidden>${items}</div>
	<input type="hidden" name="${escapeHtml(options.name)}" value="${escapeHtml(current?.value ?? "")}">
</div>`;
}

export type MenuEntry =
  | {
      readonly kind: "link";
      readonly label: string;
      readonly href: string;
      readonly icon?: IconName;
      readonly current?: boolean;
    }
  | {
      readonly kind: "action";
      readonly label: string;
      readonly attributes: string;
      readonly icon?: IconName;
    }
  | { readonly kind: "separator" }
  | { readonly kind: "label"; readonly label: string };

/** An action menu opened by `trigger`, which must be a button with the `data-popover-trigger` attribute. */
export function menu(
  trigger: string,
  entries: readonly MenuEntry[],
  align: "start" | "end" = "end"
): string {
  const items = entries
    .map((entry) => {
      if (entry.kind === "separator") {
        return '<div class="menu-separator" role="separator"></div>';
      }
      if (entry.kind === "label") {
        return `<div class="menu-label">${escapeHtml(entry.label)}</div>`;
      }
      const inner = `${entry.icon ? icon(entry.icon) : ""}<span class="label">${escapeHtml(entry.label)}</span><span class="check">${icon("check")}</span>`;
      return entry.kind === "link"
        ? `<a class="menu-item" role="menuitem" href="${escapeHtml(entry.href)}"${entry.current ? ' aria-current="true"' : ""}>${inner}</a>`
        : `<button class="menu-item" role="menuitem" ${entry.attributes}>${inner}</button>`;
    })
    .join("");
  return `<div class="popover" data-popover data-align="${align}">${trigger}<div class="menu" role="menu" tabindex="-1" hidden>${items}</div></div>`;
}

/** A switch inside a form of its own that posts `name=true` when on, and nothing when off. */
export function switchForm(
  action: string,
  options: { name: string; label: string; checked: boolean }
): string {
  return `<form method="post" action="${escapeHtml(action)}"><input class="switch" type="checkbox" role="switch" name="${escapeHtml(options.name)}" value="true" aria-label="${escapeHtml(options.label)}"${options.checked ? " checked" : ""} data-autosubmit></form>`;
}

export function checkbox(
  label: string,
  options: { name: string; checked?: boolean }
): string {
  return `<label class="check-row"><input class="checkbox" type="checkbox" name="${escapeHtml(options.name)}" value="true"${options.checked ? " checked" : ""}>${escapeHtml(label)}</label>`;
}

/** A modal dialog with a form. Open it with a button that has `data-dialog-open="<id>"`. */
export function dialog(
  id: string,
  options: { title: string; action: string; body: string; submit: string }
): string {
  return `<dialog class="dialog" id="${escapeHtml(id)}" aria-labelledby="${escapeHtml(id)}-title">
	<form method="post" action="${escapeHtml(options.action)}">
		<header class="dialog-header"><h2 id="${escapeHtml(id)}-title">${escapeHtml(options.title)}</h2>${button("Close", { variant: "ghost", icon: "close", size: "icon", attributes: 'type="button" data-dialog-close' })}</header>
		<div class="dialog-body">${options.body}</div>
		<footer class="dialog-footer">${button("Cancel", { attributes: 'type="button" data-dialog-close' })}${button(options.submit, { variant: "primary", attributes: 'type="submit"' })}</footer>
	</form>
</dialog>`;
}

export function settingsCard(rows: readonly string[], attributes = ""): string {
  return `<div class="settings-card"${attributes ? ` ${attributes}` : ""}>${rows.join("")}</div>`;
}

/** A settings row: label and description on the left, `control` on the right. */
export function settingsRow(
  label: string,
  description: string | null,
  control: string,
  options: { lead?: string; compact?: boolean } = {}
): string {
  const lead = options.lead
    ? `<span class="settings-lead">${options.lead}</span>`
    : "";
  return `<div class="settings-row${options.compact ? " compact" : ""}">${lead}<div class="settings-text"><strong>${escapeHtml(label)}</strong>${description ? `<span>${escapeHtml(description)}</span>` : ""}</div>${control}</div>`;
}

/** The content of a settings-style page: its title and sections. */
export function pageContent(title: string, content: string): string {
  return `<div class="page"><div class="page-content"><h1 class="page-title">${title}</h1>${content}</div></div>`;
}

export function pageSection(title: string | null, content: string): string {
  return `<section class="page-section">${title ? `<h2>${escapeHtml(title)}</h2>` : ""}${content}</section>`;
}

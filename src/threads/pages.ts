import { composer, message } from "../platform/ui/components.ts";
import { type ShellContext, shell } from "../workspaces/shell.ts";
import type { Channel, ThreadSummary } from "../workspaces/workspaces.ts";
import type { Message, ThreadMessages } from "./threads.ts";

const escapeHtml = Bun.escapeHTML;

export function threadPage(
  context: ShellContext,
  channel: Channel,
  thread: ThreadSummary
): string {
  const base = `/w/${context.workspace!.id}/t/${thread.id}`;
  return shell(context, {
    title: thread.title,
    header: `<span class="breadcrumb">${escapeHtml(channel.name)} › </span>${escapeHtml(thread.title)}`,
    main: `<section id="transcript" class="transcript" aria-live="polite"></section>
			${composer(`Message #${channel.name}`, `@post('${base}/messages')`)}`,
    artifacts: true,
    init: `@get('${base}/events')`,
  });
}

/** The transcript element that the thread's event stream patches after every change. */
export function transcript(state: ThreadMessages): string {
  const items = state.messages.map((m: Message) => message(m)).join("");
  const working =
    state.running && !state.messages.some((m) => m.streaming)
      ? '<p class="working">Golem is working…</p>'
      : "";
  const empty =
    items === "" && !working
      ? '<div class="empty"><strong>Ask Golem anything</strong></div>'
      : "";
  return `<section id="transcript" class="transcript" aria-live="polite">${items}${working}${empty}</section>`;
}

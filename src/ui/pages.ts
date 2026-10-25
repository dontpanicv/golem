import type { Integration } from "../integrations/integrations.ts";
import { integrationsSection } from "../integrations/pages.ts";
import type { LlmStatus } from "../llm/llm.ts";
import { llmCard } from "../llm/pages.ts";
import {
  avatar,
  badge,
  button,
  composer,
  empty,
  settingsCard,
  settingsRow,
} from "../platform/ui/components.ts";
import { icon } from "../platform/ui/icons.ts";
import type { Channel, Member, ThreadSummary } from "../workspaces.ts";
import { type ShellContext, shell } from "./shell.ts";

const escapeHtml = Bun.escapeHTML;

export function newWorkspacePage(context: ShellContext): string {
  return shell(context, {
    title: "New workspace",
    main: page(
      "Create a workspace",
      section(
        null,
        `<form method="post" action="/workspaces">${settingsCard([
          settingsRow(
            "Name",
            "Each workspace has its own channels, threads, members, and integrations.",
            `<input class="input" name="name" placeholder="Family" aria-label="Name" required autofocus>${button("Create", { variant: "primary", attributes: 'type="submit"' })}`
          ),
        ])}</form>`
      )
    ),
  });
}

export function channelPage(context: ShellContext, channel: Channel): string {
  const workspaceId = context.workspace!.id;
  const threads = channel.threads.length
    ? `<div class="list">${channel.threads.map((thread) => threadRow(workspaceId, thread)).join("")}</div>`
    : empty("compose", "No threads yet");
  return shell(context, {
    title: `#${channel.name}`,
    header: `<span class="breadcrumb"># </span>${escapeHtml(channel.name)}`,
    main: `<div class="transcript">${threads}</div>
			${composer(`Start a thread in #${channel.name}`, { post: `/w/${workspaceId}/c/${channel.id}/threads` })}`,
  });
}

function threadRow(workspaceId: string, thread: ThreadSummary): string {
  const time = new Date(thread.updatedAt).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `<a class="list-row" href="/w/${workspaceId}/t/${thread.id}">${icon("compose")}${escapeHtml(thread.title)}<span class="meta">${time}</span></a>`;
}

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

export function workspaceSettingsPage(
  context: ShellContext,
  members: readonly Member[],
  integrations: readonly Integration[]
): string {
  const base = `/w/${context.workspace!.id}`;
  const memberRows = members.map((member) =>
    settingsRow(member.name, member.email, badge(member.role), {
      lead: avatar(member.name),
      compact: true,
    })
  );
  const addMember = `<form method="post" action="${base}/members">${settingsRow(
    "Add a member",
    "They need a Golem account first.",
    `<input class="input" name="email" type="email" placeholder="name@example.com" aria-label="Email" required>${button("Add", { attributes: 'type="submit"' })}`
  )}</form>`;
  const main = page(
    `${escapeHtml(context.workspace!.name)}`,
    section("Members", settingsCard([...memberRows, addMember])) +
      section(
        "Integrations",
        integrationsSection(context.workspace!.id, integrations)
      )
  );
  return shell(
    { ...context, current: { page: "workspace-settings" } },
    { title: "Workspace settings", main }
  );
}

export function settingsPage(context: ShellContext, llm: LlmStatus): string {
  const main = page(
    "Settings",
    section("LLM provider", llmCard(llm)) +
      section(
        "Account",
        settingsCard([
          settingsRow(context.user.name, context.user.email, "", {
            lead: avatar(context.user.name),
          }),
          settingsRow(
            "Sign out",
            "Sign out of Golem on this device.",
            `<form method="post" action="/logout">${button("Sign out", { attributes: 'type="submit"' })}</form>`
          ),
        ])
      )
  );
  return shell(
    { ...context, current: { page: "settings" } },
    { title: "Settings", main }
  );
}

function page(title: string, content: string): string {
  return `<div class="page"><div class="page-content"><h1 class="page-title">${title}</h1>${content}</div></div>`;
}

function section(title: string | null, content: string): string {
  return `<section class="page-section">${title ? `<h2>${escapeHtml(title)}</h2>` : ""}${content}</section>`;
}

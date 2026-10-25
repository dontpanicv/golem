import type { LlmStatus } from "../llm/llm.ts";
import { llmCard } from "../llm/pages.ts";
import {
  avatar,
  badge,
  button,
  checkbox,
  composer,
  dialog,
  empty,
  settingsCard,
  settingsRow,
  switchForm,
  textField,
} from "../platform/ui/components.ts";
import { icon } from "../platform/ui/icons.ts";
import type {
  Channel,
  Integration,
  Member,
  ThreadSummary,
} from "../workspaces.ts";
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
        `<p class="muted">Turn on what your agents may use here. A credential is yours alone, or shared with every agent in the workspace.</p>${integrations.map((integration) => integrationCard(base, integration)).join("")}`
      )
  );
  return shell(
    { ...context, current: { page: "workspace-settings" } },
    { title: "Workspace settings", main }
  );
}

function integrationCard(base: string, integration: Integration): string {
  const header = settingsRow(
    integration.name,
    `${credentialCount(integration.credentials.length)} · ${integration.secretLabel}`,
    switchForm(`${base}/integrations/${integration.id}`, {
      name: "enabled",
      label: `Use ${integration.name}`,
      checked: integration.enabled,
    })
  );
  const credentials = integration.credentials.map((credential) =>
    settingsRow(
      credential.label,
      `Added by ${credential.ownerName}`,
      `${credential.shared ? badge("Shared with workspace", "accent") : badge("Only me")}${
        credential.mine
          ? `<form method="post" action="${base}/credentials/${credential.id}/delete">${button(`Delete ${credential.label}`, { variant: "ghost", icon: "trash", size: "icon", attributes: 'type="submit"' })}</form>`
          : ""
      }`,
      { lead: icon("key"), compact: true }
    )
  );
  const dialogId = `add-credential-${integration.id}`;
  const add = `<div class="settings-row compact">${button("Add credential", { icon: "plus", size: "small", attributes: `type="button" data-dialog-open="${dialogId}"` })}</div>`;
  return (
    settingsCard([header, ...credentials, add]) +
    dialog(dialogId, {
      title: `Add a ${integration.name} credential`,
      action: `${base}/integrations/${integration.id}/credentials`,
      submit: "Add credential",
      body: `${textField("Label", { name: "label", placeholder: "Family account", required: true, autofocus: true })}
				${textField(integration.secretLabel, { name: "secret", type: "password", autocomplete: "off", required: true })}
				${checkbox("Share with all agents in this workspace", { name: "shared" })}`,
    })
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

function credentialCount(count: number): string {
  if (count === 0) {
    return "No credentials";
  }
  return count === 1 ? "1 credential" : `${count} credentials`;
}

function page(title: string, content: string): string {
  return `<div class="page"><div class="page-content"><h1 class="page-title">${title}</h1>${content}</div></div>`;
}

function section(title: string | null, content: string): string {
  return `<section class="page-section">${title ? `<h2>${escapeHtml(title)}</h2>` : ""}${content}</section>`;
}

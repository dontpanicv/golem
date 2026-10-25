import {
  avatar,
  badge,
  button,
  composer,
  empty,
  pageContent,
  pageSection,
  settingsCard,
  settingsRow,
} from "../platform/ui/components.ts";
import { icon } from "../platform/ui/icons.ts";
import { type ShellContext, shell } from "./shell.ts";
import type { Channel, Member, ThreadSummary } from "./workspaces.ts";

const escapeHtml = Bun.escapeHTML;

export function newWorkspacePage(context: ShellContext): string {
  return shell(context, {
    title: "New workspace",
    main: pageContent(
      "Create a workspace",
      pageSection(
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
  const active = channel.threads.filter((thread) => thread.settledAt === null);
  const settled = channel.threads
    .filter((thread) => thread.settledAt !== null)
    .sort((left, right) => right.settledAt! - left.settledAt!);
  const threads = channel.threads.length
    ? `<div class="list">${active.map((thread) => threadRow(workspaceId, thread)).join("")}
      ${settled.length ? `<details class="settled-threads"><summary>Settled (${settled.length})</summary>${settled.map((thread) => threadRow(workspaceId, thread)).join("")}</details>` : ""}</div>`
    : empty("compose", "No threads yet");
  return shell(context, {
    title: `#${channel.name}`,
    header: `<span class="breadcrumb"># </span>${escapeHtml(channel.name)}`,
    headerActions: `<a class="button ghost icon-only" href="/w/${workspaceId}/c/${channel.id}/details" aria-label="Channel details" data-tooltip="Channel details">${icon("info")}</a>`,
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
  const settled = thread.settledAt !== null;
  return `<div class="file-row"><a class="list-row" href="/w/${workspaceId}/t/${thread.id}">${icon("compose")}<span class="name">${escapeHtml(thread.title)}</span><span class="meta">${time}</span></a><form method="post" action="/w/${workspaceId}/t/${thread.id}/settled"><input type="hidden" name="settled" value="${!settled}">${button(settled ? "Un-settle thread" : "Settle thread", { variant: "ghost", icon: settled ? "inbox" : "check", size: "icon", attributes: 'type="submit"' })}</form></div>`;
}

/** The members of a workspace, and a form to add one, for the workspace settings page. */
export function membersSection(
  workspaceId: string,
  members: readonly Member[]
): string {
  const memberRows = members.map((member) =>
    settingsRow(member.name, member.email, badge(member.role), {
      lead: avatar(member.name),
      compact: true,
    })
  );
  const addMember = `<form method="post" action="/w/${workspaceId}/members">${settingsRow(
    "Add a member",
    "They need a Golem account first.",
    `<input class="input" name="email" type="email" placeholder="name@example.com" aria-label="Email" required>${button("Add", { attributes: 'type="submit"' })}`
  )}</form>`;
  return settingsCard([...memberRows, addMember]);
}

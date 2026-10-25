import {
  avatar,
  badge,
  button,
  pageContent,
  pageSection,
  settingsCard,
  settingsRow,
} from "../platform/ui/components.ts";
import { type ShellContext, shell } from "./shell.ts";
import type { Member } from "./workspaces.ts";

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

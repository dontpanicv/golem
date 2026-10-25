import type { Machine, Pairing } from "../hands/hands.ts";
import { machinesSection } from "../hands/pages.ts";
import type { Integration } from "../integrations/integrations.ts";
import { integrationsSection } from "../integrations/pages.ts";
import type { LlmStatus } from "../llm/llm.ts";
import { llmCard } from "../llm/pages.ts";
import {
  avatar,
  button,
  pageContent,
  pageSection,
  settingsCard,
  settingsRow,
} from "../platform/ui/components.ts";
import { membersSection } from "../workspaces/pages.ts";
import { type ShellContext, shell } from "../workspaces/shell.ts";
import type { Member } from "../workspaces/workspaces.ts";

const escapeHtml = Bun.escapeHTML;

export function workspaceSettingsPage(
  context: ShellContext,
  members: readonly Member[],
  hands: { machines: readonly Machine[]; pairing: Pairing | null },
  integrations: readonly Integration[]
): string {
  const main = pageContent(
    `${escapeHtml(context.workspace!.name)}`,
    pageSection("Members", membersSection(context.workspace!.id, members)) +
      pageSection(
        "Machines",
        machinesSection(context.workspace!.id, hands.machines, hands.pairing)
      ) +
      pageSection(
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
  const main = pageContent(
    "Settings",
    pageSection("LLM provider", llmCard(llm)) +
      pageSection(
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

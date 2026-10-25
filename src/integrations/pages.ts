import {
  badge,
  button,
  checkbox,
  dialog,
  settingsCard,
  settingsRow,
  switchForm,
  textField,
} from "../platform/ui/components.ts";
import { icon } from "../platform/ui/icons.ts";
import type { Integration } from "./integrations.ts";

/** The integrations of one person in a workspace, for the workspace settings page. */
export function integrationsSection(
  workspaceId: string,
  integrations: readonly Integration[]
): string {
  const base = `/w/${workspaceId}`;
  return `<p class="muted">Turn on what your agents may use here. A credential is yours alone, or shared with every agent in the workspace.</p>${integrations.map((integration) => integrationCard(base, integration)).join("")}`;
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

function credentialCount(count: number): string {
  if (count === 0) {
    return "No credentials";
  }
  return count === 1 ? "1 credential" : `${count} credentials`;
}

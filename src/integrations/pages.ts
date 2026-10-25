import {
  button,
  dialog,
  settingsCard,
  settingsRow,
  textField,
} from "../platform/ui/components.ts";
import { icon } from "../platform/ui/icons.ts";
import type { Integration } from "./integrations.ts";

/** The integrations of a workspace, for the workspace settings page. */
export function integrationsSection(
  workspaceId: string,
  integrations: readonly Integration[]
): string {
  const base = `/w/${workspaceId}`;
  return integrations
    .map((integration) => integrationCard(base, integration))
    .join("");
}

function integrationCard(base: string, integration: Integration): string {
  const header = settingsRow(
    integration.name,
    `${credentialCount(integration.credentials.length)} · ${integration.secretLabel}`,
    ""
  );
  const credentials = integration.credentials.map((credential) =>
    settingsRow(
      credential.label,
      `Added by ${credential.ownerName}`,
      `<form method="post" action="${base}/credentials/${credential.id}/delete">${button(`Delete ${credential.label}`, { variant: "ghost", icon: "trash", size: "icon", attributes: 'type="submit"' })}</form>`,
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
				${textField(integration.secretLabel, { name: "secret", type: "password", autocomplete: "off", required: true })}`,
    })
  );
}

function credentialCount(count: number): string {
  if (count === 0) {
    return "No credentials";
  }
  return count === 1 ? "1 credential" : `${count} credentials`;
}

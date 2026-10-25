import {
  button,
  settingsCard,
  settingsRow,
} from "../platform/ui/components.ts";
import type { Machine, Pairing } from "./hands.ts";

const escapeHtml = Bun.escapeHTML;

/** The machines of a workspace, for its settings page. While a pairing waits, it refreshes itself every 2 seconds. */
export function machinesSection(
  workspaceId: string,
  machines: readonly Machine[],
  pairing: Pairing | null
): string {
  const base = `/w/${workspaceId}`;
  const polling = pairing
    ? `data-on-interval__duration.2s="@get('${base}/machines')"`
    : "";
  const rows = machines.map((machine) =>
    settingsRow(
      machine.name,
      `${displayOs(machine.os)} ${machine.arch} · hands ${machine.version}`,
      `<form method="post" action="${base}/machines/${machine.id}/delete">${button(`Remove ${machine.name}`, { variant: "ghost", icon: "trash", size: "icon", attributes: 'type="submit"' })}</form>`,
      { compact: true }
    )
  );
  const add = pairing
    ? `<div class="device-login">
	<span class="muted">Run this on the Mac or Linux computer within 10 minutes</span>
	<span class="command">${escapeHtml(pairing.command)}</span>
	${button("Copy command", { attributes: `type="button" data-copy="${escapeHtml(pairing.command)}"` })}
</div>`
    : `<div class="settings-row compact"><form method="post" action="${base}/machines/pairing">${button("Add machine", { icon: "plus", size: "small", attributes: 'type="submit"' })}</form></div>`;
  return `<div id="machines">${settingsCard([...rows, add], polling)}</div>`;
}

function displayOs(os: string): string {
  return (
    ({ macos: "macOS", linux: "Linux" } as Record<string, string>)[os] ?? os
  );
}

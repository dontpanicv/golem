import {
  badge,
  button,
  select,
  settingsCard,
  settingsRow,
} from "../platform/ui/components.ts";
import type { LlmStatus } from "./llm.ts";

const escapeHtml = Bun.escapeHTML;

/** The LLM provider card. While a device login waits, it refreshes itself every 2 seconds. */
export function llmCard(llm: LlmStatus): string {
  const polling = llm.login
    ? `data-on-interval__duration.2s="@get('/settings/llm')"`
    : "";
  const status = settingsRow(llm.provider, llm.error, connection(llm));
  const login = llm.login && !llm.connected ? deviceLogin(llm.login) : "";
  const efforts =
    llm.models.find((model) => model.id === llm.model)?.efforts ?? [];
  const choices = llm.connected
    ? [
        settingsRow(
          "Model",
          null,
          `<form method="post" action="/settings/llm/model">${select({
            name: "model",
            label: "Model",
            value: llm.model,
            options: llm.models.map((model) => ({
              value: model.id,
              label: model.name,
            })),
            autosubmit: true,
          })}</form>`
        ),
        settingsRow(
          "Effort",
          null,
          `<form method="post" action="/settings/llm/effort">${select({
            name: "effort",
            label: "Effort",
            value: llm.effort,
            options: efforts.map((effort) => ({
              value: effort,
              label: EFFORT_LABELS[effort],
            })),
            autosubmit: true,
          })}</form>`
        ),
      ]
    : [];
  return `<div id="llm">${settingsCard([status, login, ...choices].filter(Boolean), polling)}</div>`;
}

function connection(llm: LlmStatus): string {
  if (llm.connected) {
    return `${badge("Connected", "success")}<form method="post" action="/settings/llm/logout">${button("Disconnect", { attributes: 'type="submit"' })}</form>`;
  }
  if (llm.login) {
    return badge("Waiting", "warning");
  }
  return `<form method="post" action="/settings/llm/login">${button("Connect", { variant: "primary", attributes: 'type="submit"' })}</form>`;
}

const EFFORT_LABELS: Record<LlmStatus["effort"], string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function deviceLogin(login: NonNullable<LlmStatus["login"]>): string {
  const host = URL.parse(login.verificationUri)?.host ?? login.verificationUri;
  return `<div class="device-login">
	<span class="muted">Enter this code at ${escapeHtml(host)}</span>
	<span class="code">${escapeHtml(login.userCode)}</span>
	<div class="device-login-actions">${button("Copy code", { attributes: `type="button" data-copy="${escapeHtml(login.userCode)}"` })}<a class="button primary" href="${escapeHtml(login.verificationUri)}" target="_blank" rel="noopener">Open ${escapeHtml(host)}</a></div>
</div>`;
}

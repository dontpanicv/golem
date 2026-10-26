import { useMutation, useQuery } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { LlmStatus } from "../app/types.ts";
import {
  Badge,
  Button,
  Select,
  SettingsCard,
  SettingsRow,
} from "../ui/components.tsx";
import { copy } from "../ui/toast.tsx";

const EFFORT_LABELS: Record<LlmStatus["effort"], string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const llmQuery = {
  queryKey: ["llm"],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    request<LlmStatus>("/llm", { signal }),
};

/** The LLM provider that every workspace shares. While a device login waits, it loads again every 2 seconds. */
export function LlmCard() {
  const { data: llm } = useQuery({
    ...llmQuery,
    refetchInterval: (query) => (query.state.data?.login ? 2000 : false),
  });
  const change = useMutation({
    mutationFn: ({
      path,
      method,
      body,
    }: {
      path: string;
      method: "POST" | "PUT";
      body?: unknown;
    }) => request<LlmStatus>(`/llm/${path}`, { method, body }),
    onSuccess: (status) => queryClient.setQueryData(llmQuery.queryKey, status),
  });
  if (!llm) {
    return <SettingsCard>{null}</SettingsCard>;
  }
  const efforts =
    llm.models.find((model) => model.id === llm.model)?.efforts ?? [];
  let connection = (
    <Button
      disabled={change.isPending}
      label="Connect"
      onClick={() => change.mutate({ path: "login", method: "POST" })}
      variant="primary"
    />
  );
  if (llm.connected) {
    connection = (
      <>
        <Badge label="Connected" tone="success" />
        <Button
          disabled={change.isPending}
          label="Disconnect"
          onClick={() => change.mutate({ path: "logout", method: "POST" })}
        />
      </>
    );
  } else if (llm.login) {
    connection = <Badge label="Waiting" tone="warning" />;
  }
  return (
    <SettingsCard>
      <SettingsRow description={llm.error} label={llm.provider}>
        {connection}
      </SettingsRow>
      {llm.login && !llm.connected ? <DeviceLogin login={llm.login} /> : null}
      {llm.connected ? (
        <>
          <SettingsRow label="Model">
            <Select
              label="Model"
              onChange={(model) =>
                change.mutate({ path: "model", method: "PUT", body: { model } })
              }
              options={llm.models.map((model) => ({
                value: model.id,
                label: model.name,
              }))}
              value={llm.model}
            />
          </SettingsRow>
          <SettingsRow label="Effort">
            <Select
              label="Effort"
              onChange={(effort) =>
                change.mutate({
                  path: "effort",
                  method: "PUT",
                  body: { effort },
                })
              }
              options={efforts.map((effort) => ({
                value: effort,
                label: EFFORT_LABELS[effort],
              }))}
              value={llm.effort}
            />
          </SettingsRow>
        </>
      ) : null}
    </SettingsCard>
  );
}

function DeviceLogin({ login }: { login: NonNullable<LlmStatus["login"]> }) {
  const host = URL.parse(login.verificationUri)?.host ?? login.verificationUri;
  return (
    <div className="device-login">
      <span className="muted">Enter this code at {host}</span>
      <span className="code">{login.userCode}</span>
      <div className="device-login-actions">
        <Button label="Copy code" onClick={() => copy(login.userCode)} />
        <a
          className="button primary"
          href={login.verificationUri}
          rel="noopener"
          target="_blank"
        >
          Open {host}
        </a>
      </div>
    </div>
  );
}

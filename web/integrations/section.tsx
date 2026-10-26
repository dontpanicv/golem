import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { Integration } from "../app/types.ts";
import {
  Button,
  Dialog,
  SettingsCard,
  SettingsRow,
  TextField,
} from "../ui/components.tsx";
import { Icon } from "../ui/icon.tsx";
import { showToast } from "../ui/toast.tsx";

/** The integrations of a workspace and their credentials. Secrets go to the server and never come back. */
export function IntegrationsSection({ workspaceId }: { workspaceId: string }) {
  const queryKey = ["workspaces", workspaceId, "integrations"];
  const { data: integrations = [] } = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      request<Integration[]>(`/workspaces/${workspaceId}/integrations`, {
        signal,
      }),
  });
  const [adding, setAdding] = useState<Integration | null>(null);
  const add = useMutation({
    mutationFn: (input: { integrationId: string; form: FormData }) =>
      request(
        `/workspaces/${workspaceId}/integrations/${input.integrationId}/credentials`,
        {
          method: "POST",
          body: {
            label: String(input.form.get("label")),
            secret: String(input.form.get("secret")),
          },
        }
      ),
    onSuccess: () => {
      setAdding(null);
      showToast("success", "Credential added");
      return queryClient.invalidateQueries({ queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: (credentialId: string) =>
      request(`/workspaces/${workspaceId}/credentials/${credentialId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      showToast("success", "Credential deleted");
      return queryClient.invalidateQueries({ queryKey });
    },
  });
  return (
    <>
      {integrations.map((integration) => (
        <SettingsCard key={integration.id}>
          <SettingsRow
            description={`${credentialCount(integration.credentials.length)} · ${integration.secretLabel}`}
            label={integration.name}
          />
          {integration.credentials.map((credential) => (
            <SettingsRow
              compact
              description={`Added by ${credential.ownerName}`}
              key={credential.id}
              label={credential.label}
              lead={<Icon name="key" />}
            >
              <Button
                icon="trash"
                label={`Delete ${credential.label}`}
                onClick={() => remove.mutate(credential.id)}
                size="icon"
                variant="ghost"
              />
            </SettingsRow>
          ))}
          <div className="settings-row compact">
            <Button
              icon="plus"
              label="Add credential"
              onClick={() => setAdding(integration)}
              size="small"
            />
          </div>
        </SettingsCard>
      ))}
      <Dialog
        busy={add.isPending}
        onClose={() => setAdding(null)}
        onSubmit={(form) =>
          adding && add.mutate({ integrationId: adding.id, form })
        }
        open={adding !== null}
        submit="Add credential"
        title={`Add a ${adding?.name ?? ""} credential`}
      >
        <TextField
          autoFocus
          label="Label"
          name="label"
          placeholder="Family account"
          required
        />
        <TextField
          autoComplete="off"
          label={adding?.secretLabel ?? "Secret"}
          name="secret"
          required
          type="password"
        />
      </Dialog>
    </>
  );
}

function credentialCount(count: number): string {
  if (count === 0) {
    return "No credentials";
  }
  return count === 1 ? "1 credential" : `${count} credentials`;
}

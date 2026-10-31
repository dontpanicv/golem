import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { Integration } from "../app/types.ts";
import {
  Button,
  Dialog,
  SettingsCard,
  SettingsRow,
  Switch,
  TextField,
} from "../ui/components.tsx";
import { Icon } from "../ui/icon.tsx";
import { showToast } from "../ui/toast.tsx";
import { useMe } from "../workspaces/data.ts";

/**
 * The integrations, with the person's own credentials, which they share with every member's turns or keep private, and
 * the ones other members shared. Secrets go to the server and never come back.
 */
export function IntegrationsSection({ workspaceId }: { workspaceId: string }) {
  const { user } = useMe();
  const base = `/workspaces/${workspaceId}`;
  const queryKey = ["workspaces", workspaceId, "integrations"];
  const { data: integrations = [] } = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      request<Integration[]>(`${base}/integrations`, {
        signal,
      }),
  });
  const [adding, setAdding] = useState<Integration | null>(null);
  const [settingClient, setSettingClient] = useState<Integration | null>(null);
  const [guiding, setGuiding] = useState<Integration | null>(null);
  const [signingIn, setSigningIn] = useState<{
    integration: Integration;
    url: string;
  } | null>(null);
  // A phone number links with a code that the person enters on their phone.
  const [linking, setLinking] = useState<{
    integration: Integration;
    code: string | null;
  } | null>(null);
  const add = useMutation({
    mutationFn: (input: { integrationId: string; form: FormData }) =>
      request(`${base}/integrations/${input.integrationId}/credentials`, {
        method: "POST",
        body: {
          label: input.form.get("label") ?? undefined,
          secret: String(input.form.get("secret")),
          address: input.form.get("address") ?? undefined,
        },
      }),
    onSuccess: () => {
      setAdding(null);
      showToast("success", "Credential added");
      return queryClient.invalidateQueries({ queryKey });
    },
  });
  // People sign in on the integration's own page, which ends at a localhost address that they paste here.
  const connect = useMutation({
    mutationFn: (integration: Integration) =>
      request<{ url: string }>(
        `${base}/integrations/${integration.id}/connect`,
        { method: "POST", body: {} }
      ),
    onSuccess: ({ url }, integration) => setSigningIn({ integration, url }),
  });
  const getCode = useMutation({
    mutationFn: (input: { integration: Integration; form: FormData }) =>
      request<{ code: string }>(
        `${base}/integrations/${input.integration.id}/connect`,
        { method: "POST", body: { phone: String(input.form.get("phone")) } }
      ),
    onSuccess: ({ code }, { integration }) => setLinking({ integration, code }),
  });
  const link = useMutation({
    mutationFn: (integration: Integration) =>
      request(`${base}/integrations/${integration.id}/sign-in`, {
        method: "POST",
        body: {},
      }),
    onSuccess: (_, integration) => {
      setLinking(null);
      showToast("success", `${integration.name} connected`);
      return queryClient.invalidateQueries({ queryKey });
    },
  });
  const signIn = useMutation({
    mutationFn: (input: { integration: Integration; form: FormData }) =>
      request(`${base}/integrations/${input.integration.id}/sign-in`, {
        method: "POST",
        body: { address: String(input.form.get("address")) },
      }),
    onSuccess: (_, { integration }) => {
      setSigningIn(null);
      showToast("success", `${integration.name} connected`);
      return queryClient.invalidateQueries({ queryKey });
    },
  });
  // The server's owner sets the OAuth client that Golem signs in with; the next sign-in uses it.
  const setClient = useMutation({
    mutationFn: (input: { integration: Integration; form: FormData }) =>
      request(`/integrations/${input.integration.id}/client`, {
        method: "PUT",
        body: {
          clientId: String(input.form.get("clientId")),
          clientSecret: String(input.form.get("clientSecret")),
        },
      }),
    onSuccess: (_, { integration }) => {
      setSettingClient(null);
      showToast("success", `${integration.name} client saved`);
      return queryClient.invalidateQueries({
        predicate: ({ queryKey: key }) => key.includes("integrations"),
      });
    },
  });
  const share = useMutation({
    mutationFn: (input: { credentialId: string; shared: boolean }) =>
      request(`${base}/credentials/${input.credentialId}`, {
        method: "PUT",
        body: { shared: input.shared },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const remove = useMutation({
    mutationFn: (credentialId: string) =>
      request(`${base}/credentials/${credentialId}`, {
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
            description={
              integration.secretLabel === null
                ? accountCount(integration.credentials.length)
                : `${accountCount(integration.credentials.length)} · ${integration.secretLabel}`
            }
            label={integration.name}
          >
            {integration.guide.length > 0 && (
              <Button
                icon="info"
                label={`Set up ${integration.name}`}
                onClick={() => setGuiding(integration)}
                size="icon"
                variant="ghost"
              />
            )}
          </SettingsRow>
          {integration.credentials.map((credential) =>
            credential.ownerId === user.id ? (
              <SettingsRow
                compact
                description={credential.shared ? "Shared" : "Private"}
                key={credential.id}
                label={credential.label}
                lead={<Icon name="key" />}
              >
                <Switch
                  checked={!credential.shared}
                  label="Private"
                  onChange={(checked) =>
                    share.mutate({
                      credentialId: credential.id,
                      shared: !checked,
                    })
                  }
                />
                <Button
                  icon="trash"
                  label={`Delete ${credential.label}`}
                  onClick={() => remove.mutate(credential.id)}
                  size="icon"
                  variant="ghost"
                />
              </SettingsRow>
            ) : (
              <SettingsRow
                compact
                description={`Shared by ${credential.ownerName}`}
                key={credential.id}
                label={credential.label}
                lead={<Icon name="key" />}
              />
            )
          )}
          <div className="settings-row compact">
            {integration.connect === "sign-in" && (
              <Button
                disabled={
                  connect.isPending || integration.client?.clientId === null
                }
                icon="link"
                label="Connect"
                onClick={() => connect.mutate(integration)}
                size="small"
              />
            )}
            {integration.client?.changeable ? (
              <Button
                icon="key"
                label="Client"
                onClick={() => setSettingClient(integration)}
                size="small"
                variant="ghost"
              />
            ) : null}
            {integration.connect === "phone" && (
              <Button
                icon="link"
                label="Link number"
                onClick={() => setLinking({ integration, code: null })}
                size="small"
              />
            )}
            {integration.connect === "secret" && (
              <Button
                icon="plus"
                label="Add credential"
                onClick={() => setAdding(integration)}
                size="small"
              />
            )}
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
        {adding?.labeled !== false && (
          <TextField
            autoFocus
            label="Label"
            name="label"
            placeholder="Family account"
            required
          />
        )}
        {adding?.address === true && (
          <TextField
            autoComplete="off"
            label="Address"
            name="address"
            placeholder="http://homeassistant.local:8123"
            required
            type="url"
          />
        )}
        <TextField
          autoComplete="off"
          autoFocus={adding?.labeled === false}
          label={adding?.secretLabel ?? "Secret"}
          name="secret"
          required
          type="password"
        />
      </Dialog>
      <Dialog
        onClose={() => setGuiding(null)}
        open={guiding !== null}
        title={`Set up ${guiding?.name ?? ""}`}
      >
        <div className="prose">
          <ol className="guide">
            {guiding?.guide.map((step) => (
              <li key={step}>
                <ReactMarkdown
                  components={{
                    a: ({ href, children }) => (
                      <a href={href} rel="noopener" target="_blank">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {step}
                </ReactMarkdown>
              </li>
            ))}
          </ol>
        </div>
      </Dialog>
      <Dialog
        busy={setClient.isPending}
        onClose={() => setSettingClient(null)}
        onSubmit={(form) =>
          settingClient &&
          setClient.mutate({ integration: settingClient, form })
        }
        open={settingClient !== null}
        submit="Save"
        title={`${settingClient?.name ?? ""} OAuth client`}
      >
        <TextField
          autoComplete="off"
          autoFocus
          defaultValue={settingClient?.client?.clientId ?? ""}
          label="Client ID"
          name="clientId"
          required
        />
        <TextField
          autoComplete="off"
          label="Client secret"
          name="clientSecret"
          required
          type="password"
        />
      </Dialog>
      <Dialog
        busy={signIn.isPending}
        onClose={() => setSigningIn(null)}
        onSubmit={(form) =>
          signingIn &&
          signIn.mutate({ integration: signingIn.integration, form })
        }
        open={signingIn !== null}
        submit="Connect"
        title={`Connect ${signingIn?.integration.name ?? ""}`}
      >
        <a
          className="button primary"
          href={signingIn?.url}
          rel="noopener"
          target="_blank"
        >
          Sign in to {signingIn?.integration.name}
        </a>
        <TextField
          autoComplete="off"
          label="Address after sign-in"
          name="address"
          placeholder="http://localhost/golem-sign-in?code=…"
          required
        />
      </Dialog>
      <Dialog
        busy={getCode.isPending || link.isPending}
        onClose={() => setLinking(null)}
        onSubmit={(form) => {
          if (!linking) {
            return;
          }
          if (linking.code === null) {
            getCode.mutate({ integration: linking.integration, form });
          } else {
            link.mutate(linking.integration);
          }
        }}
        open={linking !== null}
        submit={linking?.code ? "Done" : "Get code"}
        title={`Link ${linking?.integration.name ?? ""}`}
      >
        {linking?.code ? (
          <TextField
            label="Enter in Linked devices › Link with phone number"
            large
            readOnly
            value={linking.code}
          />
        ) : (
          <TextField
            autoComplete="tel"
            label="Phone number"
            name="phone"
            placeholder="+420 123 456 789"
            required
            type="tel"
          />
        )}
      </Dialog>
    </>
  );
}

function accountCount(count: number): string {
  if (count === 0) {
    return "Not connected";
  }
  return count === 1 ? "1 account" : `${count} accounts`;
}

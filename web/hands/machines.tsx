import { useMutation, useQuery } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { Machine, Pairing } from "../app/types.ts";
import {
  Button,
  SettingsCard,
  SettingsRow,
  Switch,
} from "../ui/components.tsx";
import { copy, showToast } from "../ui/toast.tsx";
import { useMe } from "../workspaces/data.ts";

const OS_NAMES: Record<string, string> = { macos: "macOS", linux: "Linux" };

/**
 * The person's own machines, which they share with every member's turns or keep private, and the ones other members
 * shared. While a pairing waits, they load again every 2 seconds, so the machine shows when it arrives.
 */
export function MachinesSection({ workspaceId }: { workspaceId: string }) {
  const { user } = useMe();
  const base = `/workspaces/${workspaceId}`;
  const queryKey = ["workspaces", workspaceId, "machines"];
  const { data } = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      request<{ machines: Machine[]; pairing: Pairing | null }>(
        `${base}/machines`,
        { signal }
      ),
    refetchInterval: (query) => (query.state.data?.pairing ? 2000 : false),
  });
  const pair = useMutation({
    mutationFn: () =>
      request<Pairing>(`${base}/machines/pairing`, {
        method: "POST",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const share = useMutation({
    mutationFn: (input: { machineId: string; shared: boolean }) =>
      request(`${base}/machines/${input.machineId}`, {
        method: "PUT",
        body: { shared: input.shared },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const remove = useMutation({
    mutationFn: (machineId: string) =>
      request(`${base}/machines/${machineId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      showToast("success", "Machine removed");
      return queryClient.invalidateQueries({ queryKey });
    },
  });
  return (
    <SettingsCard>
      {data?.machines.map((machine) => {
        const system = `${OS_NAMES[machine.os] ?? machine.os} ${machine.arch} · hands ${machine.version}`;
        return machine.pairedBy === user.id ? (
          <SettingsRow
            compact
            description={`${system} · ${machine.shared ? "Shared" : "Private"}`}
            key={machine.id}
            label={machine.name}
          >
            <Switch
              checked={!machine.shared}
              label="Private"
              onChange={(checked) =>
                share.mutate({ machineId: machine.id, shared: !checked })
              }
            />
            <Button
              icon="trash"
              label={`Remove ${machine.name}`}
              onClick={() => remove.mutate(machine.id)}
              size="icon"
              variant="ghost"
            />
          </SettingsRow>
        ) : (
          <SettingsRow
            compact
            description={`${system} · Shared by ${machine.pairedByName}`}
            key={machine.id}
            label={machine.name}
          />
        );
      })}
      {data?.pairing ? (
        <div className="device-login">
          <span className="muted">
            Run this on the Mac or Linux computer within 10 minutes
          </span>
          <span className="command">{data.pairing.command}</span>
          <Button
            label="Copy command"
            onClick={() => copy(data.pairing!.command)}
          />
        </div>
      ) : (
        <div className="settings-row compact">
          <Button
            disabled={pair.isPending}
            icon="plus"
            label="Add machine"
            onClick={() => pair.mutate()}
            size="small"
          />
        </div>
      )}
    </SettingsCard>
  );
}

import { useMutation, useQuery } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { Machine, Pairing } from "../app/types.ts";
import { Button, SettingsCard, SettingsRow } from "../ui/components.tsx";
import { copy, showToast } from "../ui/toast.tsx";

const OS_NAMES: Record<string, string> = { macos: "macOS", linux: "Linux" };

/**
 * The machines of a workspace, for every member's turns there, or the person's own for a null `workspaceId`, for their
 * turns in each of their workspaces. While a pairing waits, they load again every 2 seconds, so the machine shows when
 * it arrives.
 */
export function MachinesSection({
  workspaceId,
}: {
  workspaceId: string | null;
}) {
  const base = workspaceId ? `/workspaces/${workspaceId}` : "";
  const queryKey = workspaceId
    ? ["workspaces", workspaceId, "machines"]
    : ["machines"];
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
      {data?.machines.map((machine) => (
        <SettingsRow
          compact
          description={`${OS_NAMES[machine.os] ?? machine.os} ${machine.arch} · hands ${machine.version}`}
          key={machine.id}
          label={machine.name}
        >
          <Button
            icon="trash"
            label={`Remove ${machine.name}`}
            onClick={() => remove.mutate(machine.id)}
            size="icon"
            variant="ghost"
          />
        </SettingsRow>
      ))}
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

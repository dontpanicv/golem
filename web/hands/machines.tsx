import { useMutation, useQuery } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { Machine, Pairing } from "../app/types.ts";
import {
  Button,
  Menu,
  type MenuEntry,
  SettingsCard,
  SettingsRow,
} from "../ui/components.tsx";
import { copy, showToast } from "../ui/toast.tsx";
import { membersQuery, useMe } from "../workspaces/data.ts";

const OS_NAMES: Record<string, string> = { macos: "macOS", linux: "Linux" };

/**
 * The machines of a workspace, for every member's turns there, or the person's own for a null `workspaceId`, for their
 * turns in each of their workspaces. While a pairing waits, they load again every 2 seconds, so the machine shows when
 * it arrives. The member who paired a workspace's machine chooses the members whose turns change it without asking.
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
  const { user } = useMe();
  const members = useQuery({
    ...membersQuery(workspaceId ?? ""),
    enabled: workspaceId !== null,
  }).data;
  const trust = useMutation({
    mutationFn: ({
      machine,
      userIds,
    }: {
      machine: Machine;
      userIds: string[];
    }) =>
      request<Machine>(`${base}/machines/${machine.id}/trusted-members`, {
        method: "PUT",
        body: { userIds },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const trustEntries = (machine: Machine): MenuEntry[] => {
    const others = (members ?? []).filter(
      (member) => member.userId !== user.id
    );
    if (machine.pairedBy !== user.id || others.length === 0) {
      return [];
    }
    return [
      { kind: "label", label: "Changes without asking" },
      ...others.map((member): MenuEntry => {
        const trusted = machine.trustedMemberIds.includes(member.userId);
        return {
          kind: "action",
          label: member.name,
          current: trusted,
          onSelect: () =>
            trust.mutate({
              machine,
              userIds: trusted
                ? machine.trustedMemberIds.filter(
                    (userId) => userId !== member.userId
                  )
                : [...machine.trustedMemberIds, member.userId],
            }),
        };
      }),
      { kind: "separator" },
    ];
  };
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
          <Menu
            entries={[
              ...trustEntries(machine),
              {
                kind: "action",
                label: "Remove machine",
                icon: "trash",
                onSelect: () => remove.mutate(machine.id),
              },
            ]}
            trigger={
              <Button
                icon="more"
                label={`${machine.name} actions`}
                size="icon"
                variant="ghost"
              />
            }
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

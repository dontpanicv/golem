import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { Workspace } from "../app/types.ts";
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  SettingsCard,
  SettingsRow,
} from "../ui/components.tsx";
import { showToast } from "../ui/toast.tsx";
import { membersQuery, meQuery } from "./data.ts";

/** The name of a workspace and a way to delete it, for its owners. */
export function WorkspaceSection({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const rename = useMutation({
    mutationFn: (name: string) =>
      request(`/workspaces/${workspace.id}`, { method: "PUT", body: { name } }),
    onSuccess: () => {
      showToast("success", "Saved");
      return queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      request(`/workspaces/${workspace.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setDeleting(false);
      showToast("success", `Deleted ${workspace.name}`);
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      navigate({ to: "/" });
    },
  });
  return (
    <>
      <SettingsCard>
        <form
          aria-busy={rename.isPending || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate(
              String(new FormData(event.currentTarget).get("name"))
            );
          }}
        >
          <SettingsRow label="Name">
            <input
              aria-label="Name"
              className="input"
              defaultValue={workspace.name}
              key={workspace.name}
              name="name"
              required
            />
            <Button label="Save" type="submit" />
          </SettingsRow>
        </form>
        <SettingsRow label="Delete workspace">
          <Button
            label="Delete"
            onClick={() => setDeleting(true)}
            variant="danger"
          />
        </SettingsRow>
      </SettingsCard>
      <Dialog
        busy={remove.isPending}
        onClose={() => setDeleting(false)}
        onSubmit={() => remove.mutate()}
        open={deleting}
        submit="Delete workspace"
        title={`Delete ${workspace.name}?`}
      >
        <p>Its channels, threads, files, artifacts, and routines go with it.</p>
      </Dialog>
    </>
  );
}

/** The members of a workspace, and a form to add one. */
export function MembersSection({ workspaceId }: { workspaceId: string }) {
  const members = useQuery(membersQuery(workspaceId)).data ?? [];
  const add = useMutation({
    mutationFn: (email: string) =>
      request<{ name: string }>(`/workspaces/${workspaceId}/members`, {
        method: "POST",
        body: { email },
      }),
    onSuccess: (member) => {
      showToast("success", `${member.name} joined the workspace`);
      return queryClient.invalidateQueries({
        queryKey: membersQuery(workspaceId).queryKey,
      });
    },
  });
  return (
    <SettingsCard>
      {members.map((member) => (
        <SettingsRow
          compact
          description={member.email}
          key={member.userId}
          label={member.name}
          lead={<Avatar name={member.name} />}
        >
          <Badge label={member.role} />
        </SettingsRow>
      ))}
      <form
        aria-busy={add.isPending || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          add.mutate(String(new FormData(form).get("email")), {
            onSuccess: () => form.reset(),
          });
        }}
      >
        <SettingsRow
          description="They need a Golem account first."
          label="Add a member"
        >
          <input
            aria-label="Email"
            className="input"
            name="email"
            placeholder="name@example.com"
            required
            type="email"
          />
          <Button label="Add" type="submit" />
        </SettingsRow>
      </form>
    </SettingsCard>
  );
}

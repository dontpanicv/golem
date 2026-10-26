import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { Inbox } from "../app/types.ts";
import { inboxQuery } from "../workspaces/data.ts";

/** Marks one notification read, or all of the workspace's without `id`. */
export async function readNotifications(
  workspaceId: string,
  id?: string
): Promise<void> {
  const inbox = await request<Inbox>(
    `/workspaces/${workspaceId}/notifications/read`,
    { method: "POST", body: id ? { id } : {} }
  );
  queryClient.setQueryData(inboxQuery(workspaceId).queryKey, inbox);
}

import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { keyed } from "../app/collections.ts";
import { queryClient } from "../app/query.ts";
import type {
  Channel,
  Inbox,
  Member,
  ThreadSummary,
  User,
  Workspace,
} from "../app/types.ts";

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: ({ signal }) =>
    request<{ user: User; workspaces: Workspace[] }>("/me", { signal }),
});

/** The person and their workspaces; the signed-in routes render only once they are known. */
export function useMe() {
  return useQuery(meQuery).data!;
}

/** The channels and the threads of a workspace come in one response, which both collections read. */
const loading = new Map<string, Promise<{ channels: Channel[] }>>();

function workspaceState(workspaceId: string) {
  let pending = loading.get(workspaceId);
  if (!pending) {
    pending = request<{ channels: Channel[] }>(
      `/workspaces/${workspaceId}`
    ).finally(() => loading.delete(workspaceId));
    loading.set(workspaceId, pending);
  }
  return pending;
}

/** Loads the channels and threads of a workspace again, as agents start threads and channels while they work. */
export function refreshWorkspace(workspaceId: string): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: ["workspaces", workspaceId, "channels"],
  });
}

/** The channels of a workspace, in the server's order. Deleting one shows at once. */
export const channelsOf = keyed((workspaceId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `channels:${workspaceId}`,
      queryKey: ["workspaces", workspaceId, "channels", "list"],
      queryClient,
      queryFn: async () =>
        (await workspaceState(workspaceId)).channels.map(
          ({ threads, ...channel }, order) => ({ ...channel, order })
        ),
      getKey: (channel) => channel.id,
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(`/workspaces/${workspaceId}/channels/${mutation.key}`, {
            method: "DELETE",
          });
        }
      },
    })
  )
);

/** The threads of every channel of a workspace. Settling one shows at once. */
export const threadsOf = keyed((workspaceId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `threads:${workspaceId}`,
      queryKey: ["workspaces", workspaceId, "channels", "threads"],
      queryClient,
      queryFn: async () =>
        (await workspaceState(workspaceId)).channels.flatMap(
          (channel) => channel.threads
        ),
      getKey: (thread) => thread.id,
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(
            `/workspaces/${workspaceId}/threads/${mutation.key}/settled`,
            {
              method: "POST",
              body: { settled: mutation.modified.settledAt !== null },
            }
          );
        }
      },
    })
  )
);

/** The person's notifications in a workspace, newest first; the sidebar shows how many are unread. */
export function inboxQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspaces", workspaceId, "notifications"],
    queryFn: ({ signal }) =>
      request<Inbox>(`/workspaces/${workspaceId}/notifications`, { signal }),
  });
}

/** Loads the inbox again: a run that ends or a thread that opens changes it. */
export function refreshInbox(workspaceId: string): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: inboxQuery(workspaceId).queryKey,
  });
}

/** The workspace's thread that never ends; the first request makes it. */
export function orchestratorQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspaces", workspaceId, "orchestrator"],
    queryFn: ({ signal }) =>
      request<ThreadSummary>(`/workspaces/${workspaceId}/orchestrator`, {
        signal,
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function membersQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspaces", workspaceId, "members"],
    queryFn: ({ signal }) =>
      request<Member[]>(`/workspaces/${workspaceId}/members`, { signal }),
  });
}

/** Settles a thread, or brings it back. */
export function setSettled(
  workspaceId: string,
  threadId: string,
  settled: boolean
) {
  return threadsOf(workspaceId).update(threadId, (draft) => {
    draft.settledAt = settled ? Date.now() : null;
  });
}

const OPENED = "golem-opened";

/** Remembers the channel or thread page, so the workspace opens on it next time. */
export function rememberOpened(path: string): void {
  localStorage.setItem(OPENED, path);
}

/** The workspace and the channel or thread id of the page `rememberOpened` saw last. */
export function lastOpened():
  | { workspaceId: string; channelId?: string; threadId?: string }
  | undefined {
  const [, workspaceId, kind, id] =
    localStorage.getItem(OPENED)?.match(/^\/w\/([^/]+)\/(c|t)\/([^/]+)$/) ?? [];
  if (!workspaceId) {
    return undefined;
  }
  return kind === "c"
    ? { workspaceId, channelId: id }
    : { workspaceId, threadId: id };
}

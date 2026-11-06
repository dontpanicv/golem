import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { queryOptions } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { keyed } from "../app/collections.ts";
import { queryClient } from "../app/query.ts";
import type {
  FollowingChange,
  FollowingCheck,
  FollowingDetail,
  FollowingOverview,
} from "../app/types.ts";

/** The person's ledger; a state change shows at once and rolls back if the server refuses it. */
export const followingOf = keyed((workspaceId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `following:${workspaceId}`,
      queryKey: ["workspaces", workspaceId, "following"],
      queryClient,
      queryFn: ({ signal }) =>
        request<{ checks: FollowingCheck[] }>(
          `/workspaces/${workspaceId}/following`,
          { signal }
        ),
      select: (response) => response.checks,
      getKey: (check) => check.id,
      // No event stream publishes intake changes.
      refetchInterval: 30_000,
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          const input = mutation.metadata as FollowingChange;
          try {
            const detail = await request<FollowingDetail>(
              `/workspaces/${workspaceId}/following/${mutation.key}`,
              { method: "POST", body: input }
            );
            queryClient.setQueryData(
              followingDetailQuery(workspaceId, mutation.key).queryKey,
              detail
            );
          } finally {
            await queryClient.invalidateQueries({
              queryKey: followingDetailQuery(workspaceId, mutation.key)
                .queryKey,
            });
          }
        }
      },
    })
  )
);

export function followingDetailQuery(workspaceId: string, id: string) {
  return queryOptions({
    queryKey: ["workspaces", workspaceId, "following-detail", id],
    queryFn: ({ signal }) =>
      request<FollowingDetail>(`/workspaces/${workspaceId}/following/${id}`, {
        signal,
      }),
  });
}

export function changeFollowing(
  workspaceId: string,
  check: FollowingCheck,
  action: FollowingChange["action"],
  quote: string
) {
  return followingOf(workspaceId).update(
    check.id,
    {
      metadata: {
        action,
        quote,
        revision: check.revision,
      } satisfies FollowingChange,
    },
    (draft) => {
      if (action === "handled") {
        draft.state = "resolved";
      } else if (action === "stop") {
        draft.state = "stopped";
      } else if (action === "reopen") {
        draft.state = "open";
      }
      draft.updatedAt = Date.now();
    }
  ).isPersisted.promise;
}

/** All that intake holds for the person; `query` searches what it keeps. */
export function overviewQuery(workspaceId: string, query: string) {
  return queryOptions({
    queryKey: ["workspaces", workspaceId, "following-overview", query],
    queryFn: ({ signal }) =>
      request<FollowingOverview>(
        `/workspaces/${workspaceId}/following/overview?q=${encodeURIComponent(query)}`,
        { signal }
      ),
    // No event stream publishes intake changes.
    refetchInterval: 30_000,
  });
}

export async function changeUpdate(
  workspaceId: string,
  id: string,
  action: "now" | "cancel"
) {
  await request(`/workspaces/${workspaceId}/following/updates/${id}`, {
    method: "POST",
    body: { action },
  });
  await queryClient.invalidateQueries({
    queryKey: ["workspaces", workspaceId, "following-overview"],
  });
}

export async function sendFeedback(
  workspaceId: string,
  target: string,
  quote: string
) {
  await request(`/workspaces/${workspaceId}/following/feedback`, {
    method: "POST",
    body: { target, quote },
  });
  await queryClient.invalidateQueries({
    queryKey: ["workspaces", workspaceId, "following-overview"],
  });
}

/**
 * Deletes a waiting update and blocks its senders, or its group chat: Golem deletes what it read from them, with its
 * files, and reads nothing more from them.
 */
export async function deleteUpdate(workspaceId: string, id: string) {
  await request(`/workspaces/${workspaceId}/following/updates/${id}`, {
    method: "DELETE",
  });
  await queryClient.invalidateQueries({
    queryKey: ["workspaces", workspaceId, "following-overview"],
  });
}

/** Lets Golem read a blocked sender or chat again. */
export async function unblock(workspaceId: string, id: string) {
  await request(`/workspaces/${workspaceId}/following/blocks/${id}`, {
    method: "DELETE",
  });
  await queryClient.invalidateQueries({
    queryKey: ["workspaces", workspaceId, "following-overview"],
  });
}

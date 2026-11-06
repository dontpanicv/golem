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

import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { request } from "../app/api.ts";
import { keyed } from "../app/collections.ts";
import { queryClient } from "../app/query.ts";
import type { Feedback } from "../app/types.ts";

/** What the agents of a workspace reported about Golem, for the server's owner; a dismiss shows at once. */
export const feedbackOf = keyed((workspaceId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `feedback:${workspaceId}`,
      queryKey: ["workspaces", workspaceId, "feedback"],
      queryClient,
      queryFn: ({ signal }) =>
        request<{ feedback: Feedback[] }>(
          `/workspaces/${workspaceId}/feedback`,
          { signal }
        ),
      select: (response) => response.feedback,
      getKey: (feedback) => feedback.id,
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(`/workspaces/${workspaceId}/feedback/${mutation.key}`, {
            method: "DELETE",
          });
        }
      },
    })
  )
);

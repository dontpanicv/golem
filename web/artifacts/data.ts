import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { queryOptions } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { keyed } from "../app/collections.ts";
import { queryClient } from "../app/query.ts";
import type { Artifact, ArtifactRecord } from "../app/types.ts";

/**
 * The artifacts of a place, `<workspace id>/<channel id>`, or `<workspace id>/` for the workspace's own. Changing who
 * sees one, or deleting it, shows at once.
 */
export const artifactsOf = keyed((key: string) => {
  const [workspaceId, channelId] = key.split("/") as [string, string];
  return createCollection(
    queryCollectionOptions({
      id: `artifacts:${key}`,
      queryKey: ["workspaces", workspaceId, "artifacts", key],
      queryClient,
      queryFn: ({ signal }) =>
        request<{ artifacts: Artifact[] }>(
          channelId
            ? `/workspaces/${workspaceId}/channels/${channelId}/artifacts`
            : `/workspaces/${workspaceId}/artifacts`,
          { signal }
        ),
      select: (response) => response.artifacts,
      getKey: (artifact) => artifact.id,
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(`/artifacts/${mutation.key}`, {
            method: "PUT",
            body: { visibility: mutation.modified.visibility },
          });
        }
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(`/artifacts/${mutation.key}`, { method: "DELETE" });
        }
      },
    })
  );
});

/** The data an artifact keeps. */
export function recordsQuery(artifactId: string) {
  return queryOptions({
    queryKey: ["artifacts", artifactId, "records"],
    queryFn: async ({ signal }) =>
      (
        await request<{ records: ArtifactRecord[] }>(
          `/artifacts/${artifactId}`,
          { signal }
        )
      ).records,
  });
}

export async function clearData(artifactId: string): Promise<void> {
  await request(`/artifacts/${artifactId}/data`, { method: "DELETE" });
  await queryClient.invalidateQueries({
    queryKey: recordsQuery(artifactId).queryKey,
  });
}

export async function deleteRecord(
  artifactId: string,
  recordId: string
): Promise<void> {
  await request(`/artifacts/${artifactId}/records/${recordId}`, {
    method: "DELETE",
  });
  await queryClient.invalidateQueries({
    queryKey: recordsQuery(artifactId).queryKey,
  });
}

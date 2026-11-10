import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { keyed } from "../app/collections.ts";
import { queryClient } from "../app/query.ts";
import type {
  ChatSummary,
  Facts,
  Inbox,
  Member,
  Topic,
  User,
  Workspace,
} from "../app/types.ts";

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: ({ signal }) =>
    request<{ user: User; workspaces: Workspace[]; owner: boolean }>("/me", {
      signal,
    }),
});

/** The person and their workspaces; the signed-in routes render only once they are known. */
export function useMe() {
  return useQuery(meQuery).data!;
}

/** The topics and the chats of a workspace come in one response, which both collections read. */
const loading = new Map<string, Promise<{ topics: Topic[] }>>();

function workspaceState(workspaceId: string) {
  let pending = loading.get(workspaceId);
  if (!pending) {
    pending = request<{ topics: Topic[] }>(
      `/workspaces/${workspaceId}`
    ).finally(() => loading.delete(workspaceId));
    loading.set(workspaceId, pending);
  }
  return pending;
}

/** Loads the topics and chats of a workspace again, as agents start chats and topics while they work. */
export function refreshWorkspace(workspaceId: string): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: ["workspaces", workspaceId, "topics"],
  });
}

/**
 * Merges a topic into another: its chats, files, artifacts, and routines move there, and the empty topic goes.
 * Topics are never deleted.
 */
export async function mergeTopic(
  workspaceId: string,
  topicId: string,
  into: string
): Promise<void> {
  await request(`/workspaces/${workspaceId}/topics/${topicId}/merge`, {
    method: "POST",
    body: { into },
  });
  await refreshWorkspace(workspaceId);
}

/** The topics of a workspace, in the server's order. Renaming one shows at once. */
export const topicsOf = keyed((workspaceId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `topics:${workspaceId}`,
      queryKey: ["workspaces", workspaceId, "topics", "list"],
      queryClient,
      queryFn: async () =>
        (await workspaceState(workspaceId)).topics.map(
          ({ chats, ...topic }, order) => ({ ...topic, order })
        ),
      getKey: (topic) => topic.id,
      // The collection loads again after it, with the name as the server keeps it.
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(`/workspaces/${workspaceId}/topics/${mutation.key}`, {
            method: "PUT",
            body: { name: mutation.modified.name },
          });
        }
      },
    })
  )
);

/** The chats of every topic of a workspace. Settling or moving one shows at once. */
export const chatsOf = keyed((workspaceId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `chats:${workspaceId}`,
      queryKey: ["workspaces", workspaceId, "topics", "chats"],
      queryClient,
      queryFn: async () =>
        (await workspaceState(workspaceId)).topics.flatMap(
          (topic) => topic.chats
        ),
      getKey: (chat) => chat.id,
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(
            mutation.changes.topicId
              ? `/workspaces/${workspaceId}/chats/${mutation.key}/topic`
              : `/workspaces/${workspaceId}/chats/${mutation.key}/settled`,
            {
              method: "POST",
              body: mutation.changes.topicId
                ? { topicId: mutation.modified.topicId }
                : { settled: mutation.modified.settledAt !== null },
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

/** Loads the inbox again: a run that ends or a chat that opens changes it. */
export function refreshInbox(workspaceId: string): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: inboxQuery(workspaceId).queryKey,
  });
}

/** The workspace's chat that never ends; the first request makes it. */
export function orchestratorQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspaces", workspaceId, "orchestrator"],
    queryFn: ({ signal }) =>
      request<ChatSummary>(`/workspaces/${workspaceId}/orchestrator`, {
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

/** The address of a member's profile picture, or null for none or while the members load. */
export function usePicture(
  workspaceId: string,
  userId: string | null
): string | null {
  return (
    useQuery({
      ...membersQuery(workspaceId),
      select: (members) =>
        members.find((member) => member.userId === userId)?.picture ?? null,
    }).data ?? null
  );
}

export function factsQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspaces", workspaceId, "facts"],
    queryFn: ({ signal }) =>
      request<Facts>(`/workspaces/${workspaceId}/facts`, { signal }),
  });
}

/** Settles a chat, or brings it back. */
export function setSettled(
  workspaceId: string,
  chatId: string,
  settled: boolean
) {
  return chatsOf(workspaceId).update(chatId, (draft) => {
    draft.settledAt = settled ? Date.now() : null;
  });
}

const OPENED = "golem-opened";
const OPEN_TOPICS = "golem-open-topics";

/** The ids of the topics whose chats this browser shows in the sidebar; the others start folded. */
export function openTopics(): string[] {
  try {
    return JSON.parse(localStorage.getItem(OPEN_TOPICS) ?? "[]");
  } catch {
    return [];
  }
}

/** Remembers the open topics, so the sidebar shows their chats next time. */
export function rememberOpenTopics(topicIds: string[]): void {
  localStorage.setItem(OPEN_TOPICS, JSON.stringify(topicIds));
}

/** Remembers the topic or chat page, so the workspace opens on it next time. */
export function rememberOpened(path: string): void {
  localStorage.setItem(OPENED, path);
}

/** The workspace and the topic or chat id of the page `rememberOpened` saw last. */
export function lastOpened():
  | { workspaceId: string; topicId?: string; chatId?: string }
  | undefined {
  const [, workspaceId, kind, id] =
    localStorage
      .getItem(OPENED)
      ?.match(/^\/w\/([^/]+)\/(topic|chat)\/([^/]+)$/) ?? [];
  if (!workspaceId) {
    return undefined;
  }
  return kind === "topic"
    ? { workspaceId, topicId: id }
    : { workspaceId, chatId: id };
}

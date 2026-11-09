import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { queryOptions } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { request } from "../app/api.ts";
import { keyed } from "../app/collections.ts";
import { queryClient } from "../app/query.ts";
import type {
  Approval,
  Brief,
  ChatState,
  ChatSummary,
  Learned,
  Message,
  SavedFile,
} from "../app/types.ts";
import { showError } from "../ui/toast.tsx";
import { chatsOf, meQuery, refreshInbox } from "../workspaces/data.ts";

/** The last state each open chat's event stream sent, and who waits for the next one. */
const streamed = new Map<string, ChatState>();
const waiting = new Map<string, Set<(state: ChatState) => void>>();

/**
 * The messages of a chat. While its page is open, the chat's event stream writes every change into it; a message
 * someone sends shows at once and stays until the stream brings the stored one.
 */
export const messagesOf = keyed((chatId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `messages:${chatId}`,
      queryKey: ["chats", chatId],
      queryClient,
      queryFn: ({ signal }) =>
        request<ChatState>(`/chats/${chatId}`, { signal }),
      select: (state) => state.messages as Message[],
      getKey: (message) => message.id,
      // The event stream keeps the messages current, so a saved copy needs no request.
      staleTime: Number.POSITIVE_INFINITY,
      onInsert: async ({ transaction }) => {
        let delivered = true;
        for (const mutation of transaction.mutations) {
          const { files } = mutation.metadata as { files: readonly File[] };
          const arrived = delivery(chatId);
          await request(`/chats/${chatId}/messages`, {
            method: "POST",
            body: messageForm({ text: mutation.modified.text, files }),
          });
          delivered = (await arrived) && delivered;
        }
        return { refetch: !delivered };
      },
    })
  )
);

/** Sends a message with files: it shows at once, with the names of its files, and needs a connection. */
export function sendWithFiles(
  chatId: string,
  text: string,
  files: readonly File[]
) {
  return messagesOf(chatId).insert(
    {
      ...ownMessage(`local-${crypto.randomUUID()}`, text),
      files: files.map((file, index) => ({
        id: `local-${index}`,
        name: file.name,
      })),
    },
    { metadata: { files } }
  );
}

/** A message the signed-in person writes, as it shows before Golem has it. */
export function ownMessage(id: string, text: string): Message {
  const me = queryClient.getQueryData(meQuery.queryKey);
  return {
    id,
    agent: false,
    author: me?.user.name ?? "",
    authorId: me?.user.id ?? null,
    text,
    time: Date.now(),
    failed: false,
    streaming: false,
    files: [],
    work: null,
  };
}

/**
 * Whether the chat's stream brings one more message of the signed-in person within 15 s. Start it before the
 * request that sends the message, which the stream can bring before the response.
 */
export function delivery(chatId: string): Promise<boolean> {
  const userId = queryClient.getQueryData(meQuery.queryKey)?.user.id;
  const mine = (state: ChatState | undefined) =>
    state?.messages.filter((message) => message.authorId === userId).length ??
    0;
  const before = mine(streamed.get(chatId));
  return nextState(chatId, (state) => mine(state) > before);
}

/** Starts a chat in a topic; its first message is its title. */
export async function startChat(
  workspaceId: string,
  topicId: string,
  text: string,
  files: readonly File[]
): Promise<ChatSummary> {
  const chat = await request<ChatSummary>(`/workspaces/${workspaceId}/chats`, {
    method: "POST",
    body: messageForm({ topicId, text, files }),
  });
  chatsOf(workspaceId).utils.writeUpsert(chat);
  return chat;
}

export function stopChat(chatId: string): Promise<void> {
  return request(`/chats/${chatId}/stop`, { method: "POST" });
}

/** Answers an approval; the chat's stream takes it away once the agent goes on. */
export function answerApproval(
  chatId: string,
  approvalId: string,
  allow: boolean,
  scope: "once" | "turn" = "once"
): Promise<void> {
  return request(`/chats/${chatId}/approvals/${approvalId}`, {
    method: "POST",
    body: { allow, scope },
  });
}

/**
 * Follows a chat while its page is open: every change goes into its messages. `onChange` runs after each one, as
 * files and artifacts come with messages. Gives whether the agent works, and what it waits for a person to allow.
 */
export function useChatStream(
  workspaceId: string,
  chatId: string,
  onChange: () => void
): { running: boolean; approvals: readonly Approval[] } {
  const [running, setRunning] = useState(
    () => streamed.get(chatId)?.running ?? false
  );
  const [approvals, setApprovals] = useState<readonly Approval[]>(
    () => streamed.get(chatId)?.approvals ?? []
  );
  useEffect(() => {
    let source: EventSource | undefined;
    // A hidden page closes the stream, so Golem sends this chat's notifications as pushes.
    const follow = () => {
      source?.close();
      source = document.hidden ? undefined : open();
    };
    const open = () => {
      const stream = new EventSource(`/api/v1/chats/${chatId}/events`);
      let opened = false;
      stream.addEventListener("open", () => {
        opened = false;
      });
      stream.addEventListener("chat", (event) => {
        const state = JSON.parse(event.data) as ChatState;
        // The stream reads the chat's notifications before its first event.
        if (!opened) {
          opened = true;
          refreshInbox(workspaceId);
        }
        streamed.set(chatId, state);
        write(chatId, state);
        setRunning(state.running);
        setApprovals(state.approvals);
        for (const listener of waiting.get(chatId) ?? []) {
          listener(state);
        }
        onChange();
      });
      return stream;
    };
    follow();
    document.addEventListener("visibilitychange", follow);
    return () => {
      document.removeEventListener("visibilitychange", follow);
      source?.close();
    };
  }, [workspaceId, chatId, onChange]);
  return { running, approvals };
}

/**
 * Writes only the messages that changed, so a streaming answer renders only itself again, and takes out the ones the
 * chat no longer has: a streaming answer gets a new id once it is stored. Messages sent from here stay until then.
 */
function write(chatId: string, state: ChatState): void {
  const messages = messagesOf(chatId);
  const current = new Set(state.messages.map((message) => message.id));
  const gone = [...messages.keys()].filter(
    (key) => !(current.has(String(key)) || String(key).startsWith("local-"))
  );
  const changed = state.messages.filter(
    (message) =>
      JSON.stringify(messages.get(message.id)) !== JSON.stringify(message)
  );
  if (gone.length > 0 || changed.length > 0) {
    messages.utils.writeBatch(() => {
      if (gone.length > 0) {
        messages.utils.writeDelete(gone);
      }
      if (changed.length > 0) {
        messages.utils.writeUpsert(changed as Message[]);
      }
    });
  }
}

const DELIVERY_MS = 15_000;

/** Whether the chat's stream sends a state that `ready` accepts within 15 s. */
function nextState(
  chatId: string,
  ready: (state: ChatState) => boolean
): Promise<boolean> {
  return new Promise((resolve) => {
    const listeners = waiting.get(chatId) ?? new Set();
    waiting.set(chatId, listeners);
    const done = (result: boolean) => {
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(result);
    };
    const listener = (state: ChatState) => ready(state) && done(true);
    const timer = setTimeout(() => done(false), DELIVERY_MS);
    listeners.add(listener);
  });
}

function messageForm(fields: {
  topicId?: string;
  text: string;
  files: readonly File[];
}): FormData {
  const form = new FormData();
  if (fields.topicId) {
    form.set("topicId", fields.topicId);
  }
  form.set("text", fields.text);
  for (const file of fields.files) {
    form.append("files", file);
  }
  return form;
}

/** A topic, or the workspace's own files and artifacts for a null `topicId`, which the orchestrator keeps. */
export interface Place {
  readonly workspaceId: string;
  readonly topicId: string | null;
}

/**
 * Moves a chat to another topic: it shows there at once, and goes back with the reason if Golem refuses. Then both
 * topics show the files and artifacts that moved with it.
 */
export async function moveChat(
  workspaceId: string,
  chatId: string,
  from: string,
  to: string
): Promise<void> {
  try {
    await chatsOf(workspaceId).update(chatId, (draft) => {
      draft.topicId = to;
    }).isPersisted.promise;
  } catch (error) {
    showError(error);
    return;
  }
  const keys = [from, to].map((topicId) => placeKey({ workspaceId, topicId }));
  await queryClient.invalidateQueries({
    predicate: ({ queryKey }) => keys.some((key) => queryKey.includes(key)),
  });
}

export function placeKey(place: Place): string {
  return `${place.workspaceId}/${place.topicId ?? ""}`;
}

function placeOf(key: string): Place {
  const [workspaceId, topicId] = key.split("/") as [string, string];
  return { workspaceId, topicId: topicId || null };
}

function filesPath({ workspaceId, topicId }: Place): string {
  return topicId
    ? `/workspaces/${workspaceId}/topics/${topicId}/files`
    : `/workspaces/${workspaceId}/files`;
}

/** The files of a place, oldest first. Deleting one shows at once. */
export const filesOf = keyed((key: string) => {
  const place = placeOf(key);
  return createCollection(
    queryCollectionOptions({
      id: `files:${key}`,
      queryKey: ["workspaces", place.workspaceId, "files", key],
      queryClient,
      queryFn: ({ signal }) =>
        request<{ files: SavedFile[] }>(filesPath(place), { signal }),
      select: (response) => response.files,
      getKey: (file) => file.id,
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(
            `/workspaces/${place.workspaceId}/files/${mutation.key}`,
            { method: "DELETE" }
          );
        }
      },
    })
  );
});

export async function uploadFiles(
  place: Place,
  files: readonly File[]
): Promise<void> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }
  const response = await request<{ files: SavedFile[] }>(filesPath(place), {
    method: "POST",
    body: form,
  });
  filesOf(placeKey(place)).utils.writeUpsert(response.files);
}

export function briefQuery(workspaceId: string, topicId: string) {
  return queryOptions({
    queryKey: ["workspaces", workspaceId, "brief", topicId],
    queryFn: ({ signal }) =>
      request<{ brief: Brief | null }>(
        `/workspaces/${workspaceId}/topics/${topicId}/brief`,
        { signal }
      ),
  });
}

/** What Golem learned that the person sees, facts first. A correction or a delete shows at once. */
export const learnedOf = keyed((workspaceId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `learned:${workspaceId}`,
      queryKey: ["workspaces", workspaceId, "learned"],
      queryClient,
      queryFn: ({ signal }) =>
        request<{ learned: Learned[] }>(`/workspaces/${workspaceId}/learned`, {
          signal,
        }),
      select: (response) => response.learned,
      getKey: (entry) => entry.id,
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(`/workspaces/${workspaceId}/learned/${mutation.key}`, {
            method: "PUT",
            body: { text: mutation.modified.text },
          });
        }
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(`/workspaces/${workspaceId}/learned/${mutation.key}`, {
            method: "DELETE",
          });
        }
      },
    })
  )
);

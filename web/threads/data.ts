import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { queryOptions } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { request } from "../app/api.ts";
import { keyed } from "../app/collections.ts";
import { queryClient } from "../app/query.ts";
import type {
  Brief,
  Message,
  SavedFile,
  ThreadState,
  ThreadSummary,
} from "../app/types.ts";
import { meQuery, threadsOf } from "../workspaces/data.ts";

/** The last state each open thread's event stream sent, and who waits for the next one. */
const streamed = new Map<string, ThreadState>();
const waiting = new Map<string, Set<(state: ThreadState) => void>>();

/**
 * The messages of a thread. While its page is open, the thread's event stream writes every change into it; a message
 * someone sends shows at once and stays until the stream brings the stored one.
 */
export const messagesOf = keyed((threadId: string) =>
  createCollection(
    queryCollectionOptions({
      id: `messages:${threadId}`,
      queryKey: ["threads", threadId],
      queryClient,
      queryFn: ({ signal }) =>
        request<ThreadState>(`/threads/${threadId}`, { signal }),
      select: (state) => state.messages as Message[],
      getKey: (message) => message.id,
      // The event stream keeps the messages current, so a saved copy needs no request.
      staleTime: Number.POSITIVE_INFINITY,
      onInsert: async ({ transaction }) => {
        let delivered = true;
        for (const mutation of transaction.mutations) {
          const { files } = mutation.metadata as { files: readonly File[] };
          const arrived = delivery(threadId);
          await request(`/threads/${threadId}/messages`, {
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
  threadId: string,
  text: string,
  files: readonly File[]
) {
  return messagesOf(threadId).insert(
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
 * Whether the thread's stream brings one more message of the signed-in person within 15 s. Start it before the
 * request that sends the message, which the stream can bring before the response.
 */
export function delivery(threadId: string): Promise<boolean> {
  const userId = queryClient.getQueryData(meQuery.queryKey)?.user.id;
  const mine = (state: ThreadState | undefined) =>
    state?.messages.filter((message) => message.authorId === userId).length ??
    0;
  const before = mine(streamed.get(threadId));
  return nextState(threadId, (state) => mine(state) > before);
}

/** Starts a thread in a channel; its first message is its title. */
export async function startThread(
  workspaceId: string,
  channelId: string,
  text: string,
  files: readonly File[]
): Promise<ThreadSummary> {
  const thread = await request<ThreadSummary>(
    `/workspaces/${workspaceId}/threads`,
    { method: "POST", body: messageForm({ channelId, text, files }) }
  );
  threadsOf(workspaceId).utils.writeUpsert(thread);
  return thread;
}

export function stopThread(threadId: string): Promise<void> {
  return request(`/threads/${threadId}/stop`, { method: "POST" });
}

/**
 * Follows a thread while its page is open: every change goes into its messages. `onChange` runs after each one, as
 * files and artifacts come with messages. Gives whether the agent works.
 */
export function useThreadStream(
  threadId: string,
  onChange: () => void
): boolean {
  const [running, setRunning] = useState(
    () => streamed.get(threadId)?.running ?? false
  );
  useEffect(() => {
    let source: EventSource | undefined;
    // A hidden page closes the stream, so Golem sends this thread's notifications as pushes.
    const follow = () => {
      source?.close();
      source = document.hidden ? undefined : open();
    };
    const open = () => {
      const stream = new EventSource(`/api/v1/threads/${threadId}/events`);
      stream.addEventListener("thread", (event) => {
        const state = JSON.parse(event.data) as ThreadState;
        streamed.set(threadId, state);
        write(threadId, state);
        setRunning(state.running);
        for (const listener of waiting.get(threadId) ?? []) {
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
  }, [threadId, onChange]);
  return running;
}

/**
 * Writes only the messages that changed, so a streaming answer renders only itself again, and takes out the ones the
 * thread no longer has: a streaming answer gets a new id once it is stored. Messages sent from here stay until then.
 */
function write(threadId: string, state: ThreadState): void {
  const messages = messagesOf(threadId);
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

/** Whether the thread's stream sends a state that `ready` accepts within 15 s. */
function nextState(
  threadId: string,
  ready: (state: ThreadState) => boolean
): Promise<boolean> {
  return new Promise((resolve) => {
    const listeners = waiting.get(threadId) ?? new Set();
    waiting.set(threadId, listeners);
    const done = (result: boolean) => {
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(result);
    };
    const listener = (state: ThreadState) => ready(state) && done(true);
    const timer = setTimeout(() => done(false), DELIVERY_MS);
    listeners.add(listener);
  });
}

function messageForm(fields: {
  channelId?: string;
  text: string;
  files: readonly File[];
}): FormData {
  const form = new FormData();
  if (fields.channelId) {
    form.set("channelId", fields.channelId);
  }
  form.set("text", fields.text);
  for (const file of fields.files) {
    form.append("files", file);
  }
  return form;
}

/** A channel, or the workspace's own files and artifacts for a null `channelId`, which the orchestrator keeps. */
export interface Place {
  readonly workspaceId: string;
  readonly channelId: string | null;
}

export function placeKey(place: Place): string {
  return `${place.workspaceId}/${place.channelId ?? ""}`;
}

function placeOf(key: string): Place {
  const [workspaceId, channelId] = key.split("/") as [string, string];
  return { workspaceId, channelId: channelId || null };
}

function filesPath({ workspaceId, channelId }: Place): string {
  return channelId
    ? `/workspaces/${workspaceId}/channels/${channelId}/files`
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

export function briefQuery(workspaceId: string, channelId: string) {
  return queryOptions({
    queryKey: ["workspaces", workspaceId, "brief", channelId],
    queryFn: ({ signal }) =>
      request<{ brief: Brief | null }>(
        `/workspaces/${workspaceId}/channels/${channelId}/brief`,
        { signal }
      ),
  });
}

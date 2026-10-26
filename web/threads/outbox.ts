import {
  createCollection,
  localStorageCollectionOptions,
} from "@tanstack/react-db";
import { request, retriable } from "../app/api.ts";
import type { Message } from "../app/types.ts";
import { showToast } from "../ui/toast.tsx";
import { delivery, ownMessage, sendWithFiles } from "./data.ts";

export type Outgoing = Message & { readonly threadId: string };

/**
 * The text messages written in this browser that Golem does not have yet. They stay in localStorage through a reload,
 * every tab sees them, and each shows in its thread until the thread's stream brings the stored message.
 */
export const outbox = createCollection(
  localStorageCollectionOptions<Outgoing, string>({
    id: "outbox",
    storageKey: "golem-outbox",
    getKey: (message) => message.id,
  })
);

/** The threads whose page is open: their stream brings a sent message, so it leaves the outbox only then. */
export const followed = new Set<string>();

/**
 * Sends a message. Text goes through the outbox, so it is kept and sent when the connection comes back; a message with
 * files needs the connection now, as the outbox cannot keep files.
 */
export function sendMessage(
  threadId: string,
  text: string,
  files: readonly File[]
): Promise<unknown> {
  if (files.length > 0) {
    return sendWithFiles(threadId, text, files).isPersisted.promise;
  }
  // The id is the request id too: a retry of a message that reached Golem does not send it again.
  outbox.insert({ ...ownMessage(crypto.randomUUID(), text), threadId });
  flush();
  return Promise.resolve();
}

/** Sends what the outbox holds on start, when the connection comes back, and when the page shows again. */
export function startOutbox(): void {
  addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      flush();
    }
  });
  flush();
}

const FIRST_RETRY_MS = 2000;
const LAST_RETRY_MS = 60_000;
let retryDelay = FIRST_RETRY_MS;
let retry: ReturnType<typeof setTimeout> | undefined;
let sending = false;

/** Sends the outbox in order, from one tab at a time. A failure that a later try can fix waits and tries again. */
function flush(): void {
  if (sending) {
    return;
  }
  sending = true;
  clearTimeout(retry);
  navigator.locks
    .request("golem-outbox", { ifAvailable: true }, async (lock) => {
      if (lock) {
        await sendAll();
      }
    })
    .finally(() => {
      sending = false;
    });
}

async function sendAll(): Promise<void> {
  // The collection reads localStorage once something asks for its rows.
  await outbox.preload();
  for (;;) {
    const [next] = [...outbox.values()].sort(
      (left, right) => left.time - right.time
    );
    if (!next) {
      return;
    }
    const arrived = followed.has(next.threadId)
      ? delivery(next.threadId)
      : Promise.resolve(true);
    try {
      await request(`/threads/${next.threadId}/messages`, {
        method: "POST",
        body: { text: next.text, requestId: next.id },
      });
    } catch (error) {
      if (retriable(error)) {
        retry = setTimeout(flush, retryDelay);
        retryDelay = Math.min(retryDelay * 2, LAST_RETRY_MS);
        return;
      }
      showToast(
        "error",
        `Not sent: “${next.text.slice(0, 40)}”. ${(error as Error).message}`
      );
    }
    retryDelay = FIRST_RETRY_MS;
    await arrived;
    outbox.delete(next.id);
  }
}

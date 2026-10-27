import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from "@tanstack/query-persist-client-core";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import { del, get, set } from "idb-keyval";
import { showError } from "../ui/toast.tsx";
import { SIGNED_OUT } from "./api.ts";

const WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * The browser's copy of everything the app loaded. The collections of each module keep their rows in it, and it is
 * saved in IndexedDB, so the app opens on what it showed last and then brings it up to date.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { gcTime: WEEK, networkMode: "offlineFirst" },
  },
  mutationCache: new MutationCache({ onError: showError }),
});

const persister = createAsyncStoragePersister({
  storage: { getItem: get, setItem: set, removeItem: del },
  key: "golem",
});

/** Loads the saved copy, then saves every change to it. */
export async function restoreCache(): Promise<void> {
  // The address of the app's script holds a hash of the whole build: a new build drops the copy of an older one.
  const buster =
    document.querySelector<HTMLScriptElement>('script[type="module"]')?.src ??
    "";
  await persistQueryClientRestore({
    queryClient,
    persister,
    maxAge: WEEK,
    buster,
  }).catch(() => undefined);
  persistQueryClientSubscribe({ queryClient, persister, buster });
}

/** The id of the person whose copy and outbox this browser keeps. */
const PERSON = "golem-person";

/**
 * After a session ended or a sign-in started, asks Golem whose session this is. The same person keeps the copy and the
 * outbox, which sends again; for another person, the browser forgets both first. Signed out or offline, it waits.
 */
export async function confirmPerson(): Promise<void> {
  if (localStorage.getItem(SIGNED_OUT) === null) {
    return;
  }
  const response = await fetch("/api/v1/me").catch(() => null);
  if (!response?.ok) {
    return;
  }
  const { user } = (await response.json()) as { user: { id: string } };
  // A copy from before this tag has the person it showed; a copy of nobody known is forgotten.
  const owner =
    localStorage.getItem(PERSON) ??
    queryClient.getQueryData<{ user: { id: string } }>(["me"])?.user.id;
  if (owner !== user.id) {
    await clearCache();
  }
  localStorage.setItem(PERSON, user.id);
  localStorage.removeItem(SIGNED_OUT);
}

/** Forgets everything, as at sign-out: another person may use this browser next. */
export async function clearCache(): Promise<void> {
  // Also the outbox of messages not sent yet, and the page the app opens on.
  localStorage.clear();
  queryClient.clear();
  await persister.removeClient();
}

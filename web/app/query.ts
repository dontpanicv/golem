import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from "@tanstack/query-persist-client-core";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import { del, get, set } from "idb-keyval";
import { showError } from "../ui/toast.tsx";

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

/** The address of the app's script holds a hash of the whole build: a new build drops the copy of an older one. */
const BUSTER =
  document.querySelector<HTMLScriptElement>('script[type="module"]')?.src ?? "";

/** Loads the saved copy, then saves every change to it. */
export async function restoreCache(): Promise<void> {
  await persistQueryClientRestore({
    queryClient,
    persister,
    maxAge: WEEK,
    buster: BUSTER,
  }).catch(() => undefined);
  persistQueryClientSubscribe({ queryClient, persister, buster: BUSTER });
}

/** Forgets everything, as at sign-out: another person may use this browser next. */
export async function clearCache(): Promise<void> {
  // Also the outbox of messages not sent yet, and the page the app opens on.
  localStorage.clear();
  queryClient.clear();
  await persister.removeClient();
}

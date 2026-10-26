import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// Toasts: bottom right. Each goes after 4 s, sooner on a click; the pointer on it keeps it.

const TOAST_MS = 4000;
const TOAST_CLOSE_MS = 400;

interface Toast {
  readonly id: number;
  readonly tone: "success" | "error";
  readonly text: string;
}

let toasts: readonly Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function change(next: readonly Toast[]): void {
  toasts = next;
  for (const listener of listeners) {
    listener();
  }
}

export function showToast(tone: Toast["tone"], text: string): void {
  nextId += 1;
  change([...toasts, { id: nextId, tone, text }]);
}

/** A failed request or change: the server's message, or a general one. */
export function showError(error: unknown): void {
  showToast(
    "error",
    error instanceof Error ? error.message : "The request failed. Try again."
  );
}

/** Copies text and confirms with a toast. The clipboard needs https or localhost, which sign-in needs too. */
export async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  showToast("success", "Copied");
}

export function Toasts() {
  const list = useSyncExternalStore(subscribe, () => toasts);
  return (
    <div aria-live="polite" className="toasts">
      {list.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setClosing(true), TOAST_MS);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the toast's timer starts once, when it shows
  useEffect(() => {
    schedule();
    return () => clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (!closing) {
      return;
    }
    const removal = setTimeout(
      () => change(toasts.filter((other) => other.id !== toast.id)),
      TOAST_CLOSE_MS
    );
    return () => clearTimeout(removal);
  }, [closing, toast.id]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the close button inside takes the keyboard
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the same
    <div
      className={`toast ${toast.tone}`}
      data-state={closing ? "closing" : "open"}
      onClick={() => setClosing(true)}
      onPointerEnter={() => clearTimeout(timer.current)}
      onPointerLeave={() => closing || schedule()}
      role="status"
    >
      <span className="toast-icon" />
      <span className="toast-text">{toast.text}</span>
      <button aria-label="Dismiss" className="toast-close" type="button" />
    </div>
  );
}

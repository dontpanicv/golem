import { getRouteApi } from "@tanstack/react-router";
import { type SubmitEvent, useEffect, useState } from "react";
import { clearCache } from "../app/query.ts";
import { Avatar, Button } from "../ui/components.tsx";
import { showToast } from "../ui/toast.tsx";

const route = getRouteApi("/login");

/** Sign-in with Google, the only way in. `next` is the page to open after it, such as a members artifact. */
export function LoginPage() {
  const { next, error } = route.useSearch();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (error) {
      showToast("error", error);
    }
  }, [error]);
  const signIn = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const response = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: localPath(next) ?? "/",
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      url?: string;
      message?: string;
    } | null;
    if (response.ok && body?.url) {
      location.assign(body.url);
      return;
    }
    setBusy(false);
    showToast("error", body?.message ?? "Sign-in failed. Try again.");
  };
  return (
    <main className="auth">
      <form aria-busy={busy || undefined} onSubmit={signIn}>
        <div className="mark">
          <Avatar agent name="Golem" size="large" />
          <h1>Sign in to Golem</h1>
        </div>
        <Button
          autoFocus
          label="Continue with Google"
          size="large"
          type="submit"
          variant="primary"
        />
      </form>
    </main>
  );
}

/** Signs out on this device and forgets what the app saved. */
export async function signOut(): Promise<void> {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  await clearCache();
  location.assign("/login");
}

/** A path on this site, so that sign-in never sends anyone to another site. */
function localPath(path: string | undefined): string | null {
  return path?.startsWith("/") && !path.startsWith("//") && !path.includes("\\")
    ? path
    : null;
}

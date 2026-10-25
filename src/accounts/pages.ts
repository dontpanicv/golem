import {
  avatar,
  button,
  htmlDocument,
  type Toast,
} from "../platform/ui/components.ts";

/** `next` is the path to open after sign-in, such as a members artifact. */
export function authPage(toast: Toast, next: string | null = null): string {
  const body = `<main class="auth">
	<form method="post" action="/login">
		<div class="mark">${avatar("Golem", { agent: true, size: "large" })}<h1>Sign in to Golem</h1></div>
		${next ? `<input type="hidden" name="next" value="${Bun.escapeHTML(next)}">` : ""}
		${button("Continue with Google", { variant: "primary", size: "large", attributes: 'type="submit" autofocus' })}
	</form>
</main>`;
  return htmlDocument("Sign in · Golem", body, "", toast);
}

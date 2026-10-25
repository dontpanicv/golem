import {
  avatar,
  button,
  htmlDocument,
  type Toast,
} from "../platform/ui/components.ts";

export function authPage(toast: Toast): string {
  const body = `<main class="auth">
	<form method="post" action="/login">
		<div class="mark">${avatar("Golem", { agent: true, size: "large" })}<h1>Sign in to Golem</h1></div>
		${button("Continue with Google", { variant: "primary", size: "large", attributes: 'type="submit" autofocus' })}
	</form>
</main>`;
  return htmlDocument("Sign in · Golem", body, "", toast);
}

import type { Artifact } from "./artifacts.ts";

const escapeHtml = Bun.escapeHTML;

/**
 * The script of a link's page. The artifact's `golem` calls arrive on a port that only the frame's first page gets,
 * so a page that the frame goes to later cannot call Golem. They go to Golem with this page's cookies.
 */
const RELAY = `const frame = document.querySelector("iframe");
frame.addEventListener("load", () => {
  const channel = new MessageChannel();
  channel.port1.onmessage = async ({ data: message }) => {
    if (message?.golem !== 1) return;
    const reply = { golem: 1, id: message.id };
    try {
      const response = await fetch(frame.dataset.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: message.op, args: message.args }),
      });
      const body = await response.json();
      if (response.ok) reply.result = body.result;
      else reply.error = body.error ?? "Golem could not do it";
    } catch {
      reply.error = "Golem is not reachable";
    }
    channel.port1.postMessage(reply);
  };
  frame.contentWindow.postMessage({ golem: 1 }, "*", [channel.port2]);
}, { once: true });`;

/**
 * The page a link opens: the artifact in a sandboxed frame. Its addresses are relative, so the page works at
 * `/a/<name>` and at `/<name>` on the public host. Link previews, such as WhatsApp's, show its title.
 */
export function artifactPage(artifact: Artifact): string {
  const title = escapeHtml(artifact.title);
  return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
	<title>${title}</title>
	<meta property="og:title" content="${title}">
	<meta property="og:site_name" content="Golem">
	<meta property="og:type" content="website">
	<style>html, body { height: 100%; margin: 0; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
</head>
<body>
<iframe src="${artifact.id}/content?v=${artifact.updatedAt}" title="${title}" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" allow="fullscreen; clipboard-write; autoplay" data-rpc="${artifact.id}/rpc"></iframe>
<script>${RELAY}</script>
</body>
</html>`;
}

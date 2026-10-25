// The page of an artifact link. The artifact runs in a sandboxed frame with no access to this site; its `golem`
// calls arrive here as messages, and go to Golem with this page's cookies.

const frame = document.querySelector("iframe");

addEventListener("message", async (event) => {
  const message = event.data;
  if (event.source !== frame.contentWindow || message?.golem !== 1) {
    return;
  }
  const reply = { golem: 1, id: message.id };
  try {
    const response = await fetch(frame.dataset.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: message.op, args: message.args }),
    });
    const body = await response.json();
    if (response.ok) {
      reply.result = body.result;
    } else {
      reply.error = body.error ?? "Golem could not do it";
    }
  } catch {
    reply.error = "Golem is not reachable";
  }
  // The sandboxed frame has no origin of its own to name.
  frame.contentWindow.postMessage(reply, "*");
});

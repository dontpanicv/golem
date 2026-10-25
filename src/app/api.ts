import { HttpError } from "../platform/errors.ts";
import { type AuthedInput, type Handler, json, signedIn } from "./http.ts";

export type ApiInput = AuthedInput & { readonly body: Record<string, unknown> };

export function api(handler: (input: ApiInput) => Promise<Response>): Handler {
  return signedIn(
    async (input) => {
      const body =
        input.request.method === "GET" || input.request.method === "DELETE"
          ? {}
          : await readBody(input.request);
      return handler({ ...input, body });
    },
    () => json({ error: "Sign in first" }, 401)
  );
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  const body = await Promise.resolve()
    .then(() => JSON.parse(text))
    .catch(() => undefined);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Send a JSON object");
  }
  return body as Record<string, unknown>;
}

/** A server-sent events response that runs until the client disconnects. */
export function eventStream(
  start: (
    send: (event: string, data: unknown) => void
  ) => Promise<() => Promise<void>>
): Response {
  const encoder = new TextEncoder();
  let stop: (() => Promise<void>) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      stop = await start(send);
      // Comments keep proxies and idle timers from closing a quiet stream.
      ping = setInterval(
        () => controller.enqueue(encoder.encode(": ping\n\n")),
        15_000
      );
    },
    async cancel() {
      clearInterval(ping);
      await stop?.();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

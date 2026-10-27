import { HttpError } from "../platform/errors.ts";
import { type AuthedInput, type Handler, json, signedIn } from "./http.ts";
import { readForm, readText, rejectCrossOrigin } from "./web.ts";

/** The largest JSON body; files come as `multipart/form-data`. */
const MAX_JSON = 1024 ** 2;

export type ApiInput = AuthedInput & {
  readonly body: Record<string, unknown>;
  /** The files of a `multipart/form-data` request, whose text fields are `body`. */
  readonly files: readonly File[];
};

/** A JSON route for a signed-in person: the iOS app with its bearer token, or the web app with its session cookie. */
export function api(handler: (input: ApiInput) => Promise<Response>): Handler {
  return signedIn(
    async (input) => {
      rejectCrossOrigin(input);
      const { method, headers } = input.request;
      if (headers.get("content-type")?.startsWith("multipart/form-data")) {
        const { fields, files } = await readForm(input.request);
        return handler({ ...input, body: fields, files });
      }
      const body =
        method === "GET" || method === "DELETE"
          ? {}
          : await readBody(input.request);
      return handler({ ...input, body, files: [] });
    },
    () => json({ error: "Sign in first" }, 401)
  );
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readText(request, MAX_JSON);
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

/**
 * A server-sent events response that runs until the client disconnects, or until `recheck` throws before an event or
 * a ping, as when the person is no longer a member.
 */
export function eventStream(
  start: (
    send: (event: string, data: unknown) => void
  ) => Promise<() => Promise<void>>,
  recheck: () => unknown
): Response {
  const encoder = new TextEncoder();
  let stop: (() => Promise<void>) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  // A watcher can still send while its stop runs, after the client has gone.
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const allowed = () => {
        try {
          recheck();
          return true;
        } catch {
          cancelled = true;
          clearInterval(ping);
          controller.close();
          stop?.().catch(() => undefined);
          return false;
        }
      };
      const send = (event: string, data: unknown) => {
        if (!cancelled && allowed()) {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        }
      };
      const stopping = await start(send);
      if (cancelled) {
        // The client went before the watcher started, so nothing else stops it.
        await stopping();
        return;
      }
      stop = stopping;
      // Comments keep proxies and idle timers from closing a quiet stream.
      ping = setInterval(() => {
        if (allowed()) {
          controller.enqueue(encoder.encode(": ping\n\n"));
        }
      }, 15_000);
    },
    async cancel() {
      cancelled = true;
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

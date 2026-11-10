import { expect, test } from "bun:test";
import type { Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { withIdleTimeout, withVerbosity } from "./chat-gpt.ts";

test("every request asks for the chosen verbosity and keeps the caller's changes to its body", async () => {
  let sent: SimpleStreamOptions | undefined;
  const provider = {
    streamSimple: (_model, _context, options) => {
      sent = options;
      return undefined as never;
    },
  } satisfies Pick<Provider, "streamSimple"> as unknown as Provider;
  withVerbosity(provider, "medium").streamSimple(
    undefined as never,
    undefined as never,
    { onPayload: (body) => ({ ...(body as object), store: true }) }
  );
  expect(
    await sent!.onPayload!(
      { input: [], text: { verbosity: "low", format: "text" } },
      undefined as never
    )
  ).toEqual({
    input: [],
    store: true,
    text: { verbosity: "medium", format: "text" },
  });
});

test("every request has the idle timeout and keeps the caller's options", () => {
  let sent: SimpleStreamOptions | undefined;
  const provider = {
    streamSimple: (_model, _context, options) => {
      sent = options;
      return undefined as never;
    },
  } satisfies Pick<Provider, "streamSimple"> as unknown as Provider;
  withIdleTimeout(provider, 1000).streamSimple(
    undefined as never,
    undefined as never,
    { sessionId: "chat" }
  );
  expect(sent).toEqual({ sessionId: "chat", timeoutMs: 1000 });
});

import type { Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { LlmProvider } from "./llm.ts";

/** The idle timeout of Codex itself: a model that reasons for long is silent, so this is not short. */
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** ChatGPT through the Codex device login: one subscription for every workspace's agents. */
export const chatGpt: LlmProvider = {
  provider: withIdleTimeout(
    withVerbosity(openaiCodexProvider(), "medium"),
    IDLE_TIMEOUT_MS
  ),
  name: "ChatGPT",
  defaultModel: "gpt-6.1-sol",
  fastModel: "gpt-6-luna",
};

/**
 * Asks every answer of `provider` for `verbosity`. pi-ai sends `low` by default, which leaves no room for Golem's soul,
 * and Pi Durable passes no `textVerbosity` through; the request body takes it.
 */
export function withVerbosity(
  provider: Provider,
  verbosity: "low" | "medium" | "high"
): Provider {
  return {
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, {
        ...options,
        onPayload: async (payload, payloadModel) => {
          const body = ((await options?.onPayload?.(payload, payloadModel)) ??
            payload) as { text?: object };
          return { ...body, text: { ...body.text, verbosity } };
        },
      }),
  };
}

/**
 * Ends every request of `provider` that stays silent for `timeoutMs`, so that the run retries. Without it, pi-ai waits
 * on a stalled WebSocket for as long as the socket stays open.
 */
export function withIdleTimeout(
  provider: Provider,
  timeoutMs: number
): Provider {
  return {
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, { ...options, timeoutMs }),
  };
}

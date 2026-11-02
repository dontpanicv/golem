import type { Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { LlmProvider } from "./llm.ts";

/** ChatGPT through the Codex device login: one subscription for every workspace's agents. */
export const chatGpt: LlmProvider = {
  provider: withVerbosity(openaiCodexProvider(), "medium"),
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

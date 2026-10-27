import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { LlmProvider } from "./llm.ts";

/** ChatGPT through the Codex device login: one subscription for every workspace's agents. */
export const chatGpt: LlmProvider = {
  provider: openaiCodexProvider(),
  name: "ChatGPT",
  defaultModel: "gpt-6.1-sol",
  fastModel: "gpt-6-luna",
};

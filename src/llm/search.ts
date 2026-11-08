import type { Usage } from "@earendil-works/pi-ai";

/**
 * Web search by ChatGPT's own `web_search` tool, through the Codex backend that the ChatGPT login opens. The request
 * and its parsing follow pi-web-access (github.com/nicobailon/pi-web-access, MIT), `openai-search.ts`.
 */
export interface WebSearchResult {
  readonly answer: string;
  readonly sources: readonly WebSource[];
  /** The tokens of the search's model request, with no cost yet; `null` when ChatGPT did not say. */
  readonly usage: Usage | null;
}

export interface WebSource {
  /** `null` when the search gave none. */
  readonly title: string | null;
  readonly url: string;
}

export interface WebSearchRequest {
  /** The Codex backend, `https://chatgpt.com/backend-api`. */
  readonly baseUrl: string;
  readonly model: string;
  /** The ChatGPT access token. */
  readonly token: string;
  readonly query: string;
  /** Tests replace it. */
  readonly fetch?: typeof fetch;
}

const INSTRUCTIONS =
  "Search the web and answer concisely, only from what the web results say. Cite the sources as links in the text.";
const TIMEOUT = 60_000;
/** Where the ChatGPT access token keeps the account id, which the Codex backend wants as a header. */
const AUTH_CLAIM = "https://api.openai.com/auth";

/** Searches the web and gives ChatGPT's answer with its sources; fails when ChatGPT answers without a search. */
export async function searchWeb(
  request: WebSearchRequest
): Promise<WebSearchResult> {
  const response = await (request.fetch ?? fetch)(
    `${request.baseUrl}/codex/responses`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.token}`,
        "chatgpt-account-id": accountId(request.token),
        // As in pi-ai's own Codex requests with the same login.
        originator: "pi",
        "OpenAI-Beta": "responses=experimental",
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        instructions: INSTRUCTIONS,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: request.query }],
          },
        ],
        tools: [{ type: "web_search" }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
        store: false,
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    }
  );
  if (!response.ok) {
    throw new Error(
      `ChatGPT search failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`
    );
  }
  const { items, usage } = parsedStream(await response.text());
  if (!items.some((item) => item.type === "web_search_call")) {
    throw new Error("ChatGPT answered without searching the web.");
  }
  return { answer: answerOf(items), sources: sourcesOf(items), usage };
}

interface OutputItem {
  readonly type?: string;
  readonly content?: readonly {
    readonly text?: string;
    readonly annotations?: readonly {
      readonly type?: string;
      readonly url?: string;
      readonly title?: string;
    }[];
  }[];
  readonly action?: {
    readonly sources?: readonly {
      readonly url?: string;
      readonly title?: string;
    }[];
  };
}

interface ResponseUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
}

/** The finished output items and the usage of a Responses event stream; a failed stream throws its reason. */
function parsedStream(stream: string): {
  items: OutputItem[];
  usage: Usage | null;
} {
  const items: OutputItem[] = [];
  let usage: Usage | null = null;
  for (const line of stream.split("\n")) {
    const data = line.startsWith("data: ") ? line.slice(6).trim() : "";
    if (!data.startsWith("{")) {
      continue;
    }
    const event = JSON.parse(data) as {
      type?: string;
      item?: OutputItem;
      error?: { message?: string };
      response?: {
        error?: { message?: string } | null;
        usage?: ResponseUsage | null;
      };
    };
    // The backend can fail mid-stream with HTTP 200, for example when the subscription's limit is reached.
    if (event.type === "error" || event.type === "response.failed") {
      const reason =
        event.error?.message ?? event.response?.error?.message ?? "no reason";
      throw new Error(`ChatGPT search failed: ${reason}`);
    }
    if (event.type === "response.output_item.done" && event.item) {
      items.push(event.item);
    }
    if (event.response?.usage) {
      usage = tokens(event.response.usage);
    }
  }
  return { items, usage };
}

/** OpenAI's usage, whose input includes the cached tokens, as Golem counts it. */
function tokens(usage: ResponseUsage): Usage {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, (usage.input_tokens ?? 0) - cached),
    output: usage.output_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
    reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function answerOf(items: readonly OutputItem[]): string {
  return items
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

/** The cited sources first, then the other results of the search; http and https only, each once. */
function sourcesOf(items: readonly OutputItem[]): WebSource[] {
  const cited = items
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .flatMap((part) => part.annotations ?? [])
    .filter((annotation) => annotation.type === "url_citation");
  const found = items
    .filter((item) => item.type === "web_search_call")
    .flatMap((item) => item.action?.sources ?? []);
  const sources = new Map<string, WebSource>();
  for (const { url, title } of [...cited, ...found]) {
    const parsed = url ? URL.parse(url) : null;
    if (!(parsed?.protocol === "http:" || parsed?.protocol === "https:")) {
      continue;
    }
    if (parsed.searchParams.get("utm_source") === "openai") {
      parsed.searchParams.delete("utm_source");
    }
    const clean = parsed.toString();
    if (!sources.has(clean)) {
      sources.set(clean, { title: title?.trim() || null, url: clean });
    }
  }
  return [...sources.values()];
}

function accountId(token: string): string {
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}"
  ) as Record<string, { chatgpt_account_id?: string } | undefined>;
  const id = claims[AUTH_CLAIM]?.chatgpt_account_id;
  if (!id) {
    throw new Error(
      "The ChatGPT login has no account id; connect ChatGPT again in Settings."
    );
  }
  return id;
}

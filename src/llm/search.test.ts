import { describe, expect, test } from "bun:test";
import { searchWeb } from "./search.ts";

const claims = {
  "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
};
const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

/** The events of a Responses stream, as the Codex backend sends them. */
function stream(...events: object[]): string {
  return events
    .map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

const searched = {
  type: "response.output_item.done",
  item: {
    type: "web_search_call",
    action: {
      sources: [
        {
          url: "https://www.prague.eu/golem?utm_source=openai",
          title: "Prague",
        },
        { url: "https://en.wikipedia.org/wiki/Golem", title: "Golem" },
        { url: "javascript:alert(1)", title: "Not a page" },
        { url: "https://example.org/untitled" },
      ],
    },
  },
};
const answered = {
  type: "response.output_item.done",
  item: {
    type: "message",
    content: [
      {
        type: "output_text",
        text: "Rabbi Loew made the Golem of Prague.",
        annotations: [
          {
            type: "url_citation",
            url: "https://en.wikipedia.org/wiki/Golem?utm_source=openai",
            title: "Golem - Wikipedia",
          },
        ],
      },
    ],
  },
};

function backend(body: string, status = 200) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

const request = (fetch: typeof globalThis.fetch) => ({
  baseUrl: "https://chatgpt.com/backend-api",
  model: "gpt-6-luna",
  token,
  query: "Who made the Golem of Prague?",
  fetch,
});

describe("searchWeb", () => {
  test("asks the Codex backend to search, and gives the answer with each source once", async () => {
    const fake = backend(
      stream({ type: "response.created" }, searched, answered, {
        type: "response.completed",
        response: { output: [] },
      })
    );
    expect(await searchWeb(request(fake.fetch))).toEqual({
      answer: "Rabbi Loew made the Golem of Prague.",
      sources: [
        {
          title: "Golem - Wikipedia",
          url: "https://en.wikipedia.org/wiki/Golem",
        },
        { title: "Prague", url: "https://www.prague.eu/golem" },
        { title: null, url: "https://example.org/untitled" },
      ],
    });
    const [sent] = fake.requests;
    expect(sent!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = sent!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${token}`);
    expect(headers["chatgpt-account-id"]).toBe("account-1");
    expect(JSON.parse(String(sent!.init.body))).toMatchObject({
      model: "gpt-6-luna",
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      store: false,
      input: [{ content: [{ text: "Who made the Golem of Prague?" }] }],
    });
  });

  test("fails when ChatGPT answers without a search", async () => {
    const fake = backend(stream(answered));
    await expect(searchWeb(request(fake.fetch))).rejects.toThrow(
      "without searching"
    );
  });

  test("gives the reason of a failed request or stream", async () => {
    await expect(
      searchWeb(request(backend("Too many requests", 429).fetch))
    ).rejects.toThrow("HTTP 429: Too many requests");
    await expect(
      searchWeb(
        request(
          backend(
            stream(searched, {
              type: "response.failed",
              response: { error: { message: "usage limit reached" } },
            })
          ).fetch
        )
      )
    ).rejects.toThrow("usage limit reached");
  });

  test("refuses a token without a ChatGPT account", async () => {
    const fake = backend(stream(searched, answered));
    await expect(
      searchWeb({ ...request(fake.fetch), token: "a.e30.b" })
    ).rejects.toThrow("no account id");
    expect(fake.requests).toHaveLength(0);
  });
});

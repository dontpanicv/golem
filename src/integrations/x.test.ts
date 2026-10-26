import { describe, expect, test } from "bun:test";
import type { ITweet } from "rettiwt-api";
import { type XClient, xConnector } from "./x.ts";

function tweet(id: string, more: Partial<ITweet> = {}): ITweet {
  return {
    id,
    url: `https://x.com/nasa/status/${id}`,
    fullText: `Post ${id}`,
    createdAt: "Mon Oct 26 10:00:00 +0000 2026",
    conversationId: id,
    lang: "en",
    entities: {
      hashtags: [],
      mentionedUsers: [],
      urls: ["https://example.com/a"],
    },
    tweetBy: { userName: "nasa", fullName: "NASA" },
    likeCount: 7,
    ...more,
  } as ITweet;
}

describe("xConnector", () => {
  test("gives bookmarks as posts with the next cursor, with the client of the key", async () => {
    const calls: unknown[] = [];
    const client = (apiKey: string): XClient => ({
      user: {
        bookmarks: async (count, cursor) => {
          calls.push({ apiKey, count, cursor });
          return {
            list: [
              tweet("1", {
                media: [{ id: "m", type: "PHOTO", url: "https://img/1.jpg" }],
                quoted: tweet("2"),
              } as Partial<ITweet>),
              tweet("3", { retweetedTweet: tweet("4") }),
            ],
            next: "",
          };
        },
      },
      tweet: {
        details: async () => [],
        replies: async () => ({ list: [], next: "" }),
      },
    });
    const bookmarks = xConnector(client).tools.find(
      (tool) => tool.name === "x_bookmarks"
    )!;

    const result = await bookmarks.execute({ cursor: "c1" }, "key", undefined);

    expect(calls).toEqual([{ apiKey: "key", count: 20, cursor: "c1" }]);
    expect(result).toEqual({
      posts: [
        {
          id: "1",
          url: "https://x.com/nasa/status/1",
          author: "@nasa",
          authorName: "NASA",
          text: "Post 1",
          createdAt: "Mon Oct 26 10:00:00 +0000 2026",
          conversationId: "1",
          links: ["https://example.com/a"],
          media: [{ type: "PHOTO", url: "https://img/1.jpg" }],
          quoted: expect.objectContaining({ id: "2", author: "@nasa" }),
        },
        expect.objectContaining({ id: "4", text: "Post 4" }),
      ],
      next: null,
    });
  });

  test("gives only tools that read", () => {
    expect(xConnector().tools.map((tool) => tool.name)).toEqual([
      "x_bookmarks",
      "x_posts",
      "x_replies",
    ]);
  });
});

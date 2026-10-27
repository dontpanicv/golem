import { describe, expect, test } from "bun:test";
import { instagramConnector } from "./instagram.ts";

function reel(code: string, more: object = {}) {
  return {
    code,
    media_type: 2,
    product_type: "clips",
    taken_at: 1_793_000_000,
    user: { username: "some.baker", full_name: "Some Baker" },
    caption: { text: `Reel ${code}` },
    image_versions2: {
      candidates: [
        { url: "https://cdn/small.jpg", width: 320, height: 568 },
        { url: "https://cdn/large.jpg", width: 720, height: 1280 },
      ],
    },
    video_versions: [{ url: "https://cdn/v.mp4", width: 720, height: 1280 }],
    ...more,
  };
}

function connector(answer: (url: string) => Response) {
  const calls: { url: string; cookie: string | null }[] = [];
  const request = (async (url: string, init: RequestInit) => {
    calls.push({ url, cookie: new Headers(init.headers).get("cookie") });
    return answer(url);
  }) as typeof fetch;
  const { tools } = instagramConnector(request);
  return {
    calls,
    tool: (name: string) => tools.find((tool) => tool.name === name)!,
  };
}

describe("instagramConnector", () => {
  test("gives saved posts and reels with the next cursor, with the session cookie", async () => {
    const { calls, tool } = connector(() =>
      Response.json({
        items: [
          {
            media: reel("R1", {
              saved_collection_ids: ["17935364489792243"],
              location: { name: "Bistro", city: "Prague", lat: 50, lng: 14 },
            }),
          },
          {
            media: {
              ...reel("P1", { caption: null }),
              media_type: 8,
              product_type: "carousel_container",
              carousel_media: [
                {
                  ...reel("c1"),
                  media_type: 1,
                  video_versions: undefined,
                },
                reel("c2"),
              ],
            },
          },
        ],
        more_available: true,
        next_max_id: "m2",
      })
    );

    const result = await tool("instagram_saved").execute(
      { cursor: "m1" },
      "123%3Aabc",
      undefined
    );

    expect(calls).toEqual([
      {
        url: "https://www.instagram.com/api/v1/feed/saved/posts/?max_id=m1",
        cookie: "sessionid=123%3Aabc; ds_user_id=123",
      },
    ]);
    expect(result).toEqual({
      posts: [
        {
          id: "R1",
          url: "https://www.instagram.com/reel/R1/",
          author: "@some.baker",
          authorName: "Some Baker",
          caption: "Reel R1",
          takenAt: "2026-10-26T07:33:20.000Z",
          location: { name: "Bistro", city: "Prague", lat: 50, lng: 14 },
          media: [
            {
              type: "video",
              url: "https://cdn/v.mp4",
              thumbnail: "https://cdn/large.jpg",
            },
          ],
          collections: ["17935364489792243"],
        },
        expect.objectContaining({
          url: "https://www.instagram.com/p/P1/",
          caption: "",
          media: [
            { type: "image", url: "https://cdn/large.jpg" },
            expect.objectContaining({ type: "video" }),
          ],
        }),
      ],
      next: "m2",
    });
  });

  test("tells to connect again when Instagram sends the session to its sign-in page", async () => {
    const { calls, tool } = connector(
      () => new Response(null, { status: 302 })
    );

    await expect(
      tool("instagram_collection").execute(
        { id: "17851406186124602" },
        "s",
        undefined
      )
    ).rejects.toThrow("connect Instagram again");
    expect(calls[0]!.url).toBe(
      "https://www.instagram.com/api/v1/feed/collection/17851406186124602/posts/"
    );
  });

  test("tells when Instagram answers with its page instead of data", async () => {
    const { tool } = connector(
      () =>
        new Response("<!DOCTYPE html>", {
          headers: { "content-type": "text/html" },
        })
    );

    await expect(
      tool("instagram_saved").execute({}, "s", undefined)
    ).rejects.toThrow("a page, not data");
  });

  test("gives only tools that read", () => {
    expect(instagramConnector().tools.map((tool) => tool.name)).toEqual([
      "instagram_saved",
      "instagram_collection",
    ]);
  });
});

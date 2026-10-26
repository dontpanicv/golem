import { Type } from "@earendil-works/pi-ai";
import { type ITweet, Rettiwt } from "rettiwt-api";
import type { Connector } from "./integrations.ts";

/** How long one call to X may take. */
const TIMEOUT_MS = 30 * 1000;

/** The calls of Rettiwt that the tools make; tests pass their own. */
export interface XClient {
  readonly user: {
    readonly bookmarks: (count?: number, cursor?: string) => Promise<Page>;
  };
  readonly tweet: {
    readonly details: (ids: string[]) => Promise<ITweet[]>;
    readonly replies: (id: string, cursor?: string) => Promise<Page>;
  };
}

interface Page {
  readonly list: ITweet[];
  readonly next: string;
}

/** A post as the tools give it: what an agent reads, without X's counters and profile fields. */
export interface Post {
  readonly id: string;
  readonly url: string;
  /** The author's handle, such as `@nasa`. */
  readonly author: string;
  readonly authorName: string;
  readonly text: string;
  readonly createdAt: string;
  /** The first post of its thread; `x_replies` of it gives the thread. */
  readonly conversationId: string;
  readonly replyTo?: string;
  readonly links: string[];
  readonly media: { type: string; url: string }[];
  readonly quoted?: Post;
}

/**
 * X through Rettiwt-API (https://github.com/Rishikant181/Rettiwt-API), which calls X's own web API with the cookies of
 * the person's session. It is not X's paid API, and X can limit or ban an account that uses it. Agents only read.
 */
export function xConnector(
  client: (apiKey: string) => XClient = (apiKey) =>
    new Rettiwt({ apiKey, timeout: TIMEOUT_MS })
): Connector {
  return {
    id: "x",
    name: "X",
    description:
      "The person's X (Twitter) account: their bookmarks, newest first, and posts with their replies and threads. Read only.",
    secretLabel: "API key",
    tools: [
      {
        name: "x_bookmarks",
        description:
          "The posts that the person bookmarked, newest first. Pass `cursor` from `next` for older ones.",
        parameters: Type.Object({
          limit: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 100,
              description: "At most; 20 when not given.",
            })
          ),
          cursor: Type.Optional(Type.String()),
        }),
        execute: async ({ limit, cursor }, apiKey) =>
          page(await client(apiKey).user.bookmarks(limit ?? 20, cursor)),
      },
      {
        name: "x_posts",
        description: "Posts by their ids, such as quoted posts.",
        parameters: Type.Object({
          ids: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }),
        }),
        execute: async ({ ids }, apiKey) => ({
          posts: (await client(apiKey).tweet.details(ids)).map(post),
        }),
      },
      {
        name: "x_replies",
        description:
          "The replies to a post. The replies of its author to the first post of a thread are the rest of the thread. Pass `cursor` from `next` for more.",
        parameters: Type.Object({
          id: Type.String({ description: "The post's id." }),
          cursor: Type.Optional(Type.String()),
        }),
        execute: async ({ id, cursor }, apiKey) =>
          page(await client(apiKey).tweet.replies(id, cursor)),
      },
    ],
  };
}

function page({ list, next }: Page): { posts: Post[]; next: string | null } {
  return { posts: list.map(post), next: next || null };
}

/** The post that a tool gives for a tweet; for a repost, the original post. */
export function post(tweet: ITweet): Post {
  if (tweet.retweetedTweet) {
    return post(tweet.retweetedTweet);
  }
  return {
    id: tweet.id,
    url: tweet.url,
    author: `@${tweet.tweetBy.userName}`,
    authorName: tweet.tweetBy.fullName,
    text: tweet.fullText,
    createdAt: tweet.createdAt,
    conversationId: tweet.conversationId,
    ...(tweet.replyTo ? { replyTo: tweet.replyTo } : {}),
    links: tweet.entities.urls,
    media: (tweet.media ?? []).map(({ type, url }) => ({ type, url })),
    ...(tweet.quoted ? { quoted: post(tweet.quoted) } : {}),
  };
}

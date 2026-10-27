import { Type } from "@earendil-works/pi-ai";
import type { Connector } from "./integrations.ts";

/** How long one call to Instagram may take. */
const TIMEOUT_MS = 30 * 1000;
/** The id of Instagram's web app, which its web API asks for. */
const WEB_APP_ID = "936619743392459";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** A saved post or reel as the tools give it: what an agent reads, without Instagram's counters. */
export interface InstagramPost {
  /** The shortcode of its address. */
  readonly id: string;
  readonly url: string;
  /** The author's handle, such as `@nasa`. */
  readonly author: string;
  readonly authorName: string;
  readonly caption: string;
  readonly takenAt: string;
  readonly location?: Location;
  readonly media: Media[];
  /** The ids of the person's collections that hold it, in `instagram_saved`; `instagram_collection` gives one's posts. */
  readonly collections: string[];
}

interface Location {
  readonly name: string;
  readonly city?: string;
  readonly lat?: number;
  readonly lng?: number;
}

interface Media {
  readonly type: "image" | "video";
  readonly url: string;
  /** The picture that a video shows before it plays. */
  readonly thumbnail?: string;
}

/** The fields of a media item of Instagram's web API that the tools read. */
interface WebMedia {
  readonly code: string;
  readonly media_type: number;
  readonly product_type?: string;
  readonly taken_at: number;
  readonly user: { readonly username: string; readonly full_name?: string };
  readonly caption?: { readonly text: string } | null;
  readonly location?: {
    readonly name: string;
    readonly city?: string;
    readonly lat?: number;
    readonly lng?: number;
  } | null;
  readonly image_versions2?: { readonly candidates: Version[] };
  readonly video_versions?: Version[];
  readonly carousel_media?: WebMedia[];
  readonly saved_collection_ids?: string[];
}

interface Version {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

interface WebPage {
  readonly items: { readonly media?: WebMedia }[];
  readonly more_available?: boolean;
  readonly next_max_id?: string | number | null;
}

/**
 * Instagram through its own web API, with the `sessionid` cookie of the person's session. Instagram has no API for
 * saved posts, and it can lock or ban an account that uses this one. Its web API gives no list of collections, only the
 * collections of each post. Agents only read.
 */
export function instagramConnector(request: typeof fetch = fetch): Connector {
  async function call<Result>(
    path: string,
    sessionId: string,
    signal: AbortSignal | undefined
  ): Promise<Result> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await request(`https://www.instagram.com/api/v1/${path}`, {
      headers: {
        // Instagram refuses a `sessionid` without the `ds_user_id` of its account, which starts it.
        cookie: `sessionid=${sessionId}; ds_user_id=${sessionId.split(/%3A|:/i)[0]}`,
        "user-agent": USER_AGENT,
        "x-ig-app-id": WEB_APP_ID,
        // Without the headers of a script's call, Instagram answers some paths with its page.
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      // Instagram sends a session that it refuses to its sign-in page.
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      throw new Error(
        response.status >= 300 && response.status < 404
          ? "Instagram refused the session cookie; connect Instagram again with a new one"
          : `Instagram answered ${response.status}`
      );
    }
    if (!response.headers.get("content-type")?.includes("json")) {
      throw new Error("Instagram answered with a page, not data");
    }
    return (await response.json()) as Result;
  }

  async function page(
    path: string,
    sessionId: string,
    cursor: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<{ posts: InstagramPost[]; next: string | null }> {
    const result = await call<WebPage>(
      cursor ? `${path}?max_id=${encodeURIComponent(cursor)}` : path,
      sessionId,
      signal
    );
    return {
      posts: result.items.flatMap(({ media }) => (media ? [post(media)] : [])),
      next:
        result.more_available && result.next_max_id
          ? String(result.next_max_id)
          : null,
    };
  }

  return {
    id: "instagram",
    name: "Instagram",
    description:
      "The person's Instagram account: the posts and reels that they saved, newest first, and the collections that they sorted them into. Read only.",
    secretLabel: "Session cookie",
    guide: [
      "Open a private window, and sign in to instagram.com.",
      "Open the developer tools. In **Application** (Chrome) or **Storage** (Firefox and Safari), open the cookies of `https://www.instagram.com`, and copy the value of `sessionid`.",
      "Close the window, but do not sign out: signing out ends the cookie.",
      "Click **Add credential**, type your handle as the label, and paste the cookie.",
      "Instagram can lock or ban an account that uses its web API this way.",
    ],
    tools: [
      {
        name: "instagram_saved",
        description:
          "All posts and reels that the person saved, in collections or not, newest first. Pass `cursor` from `next` for older ones.",
        parameters: Type.Object({ cursor: Type.Optional(Type.String()) }),
        execute: ({ cursor }, sessionId, signal) =>
          page("feed/saved/posts/", sessionId, cursor, signal),
      },
      {
        name: "instagram_collection",
        description:
          "The saved posts and reels of one collection, newest first. Pass `cursor` from `next` for older ones.",
        parameters: Type.Object({
          id: Type.String({
            pattern: "^\\d+$",
            description: "The collection's id.",
          }),
          cursor: Type.Optional(Type.String()),
        }),
        execute: ({ id, cursor }, sessionId, signal) =>
          page(
            `feed/collection/${encodeURIComponent(id)}/posts/`,
            sessionId,
            cursor,
            signal
          ),
      },
    ],
  };
}

/** The post that a tool gives for a media item of Instagram's web API. */
export function post(media: WebMedia): InstagramPost {
  return {
    id: media.code,
    url: `https://www.instagram.com/${media.product_type === "clips" ? "reel" : "p"}/${media.code}/`,
    author: `@${media.user.username}`,
    authorName: media.user.full_name ?? "",
    caption: media.caption?.text ?? "",
    takenAt: new Date(media.taken_at * 1000).toISOString(),
    ...(media.location
      ? {
          location: {
            name: media.location.name,
            ...(media.location.city ? { city: media.location.city } : {}),
            ...(media.location.lat === undefined
              ? {}
              : { lat: media.location.lat, lng: media.location.lng }),
          },
        }
      : {}),
    media: (media.carousel_media ?? [media]).flatMap(mediaOf),
    collections: media.saved_collection_ids ?? [],
  };
}

function mediaOf(media: WebMedia): Media[] {
  const picture = largest(media.image_versions2?.candidates);
  const video = largest(media.video_versions);
  if (video) {
    return [
      { type: "video", url: video, ...(picture ? { thumbnail: picture } : {}) },
    ];
  }
  return picture ? [{ type: "image", url: picture }] : [];
}

function largest(versions: Version[] | undefined): string | undefined {
  return versions?.reduce((best, version) =>
    version.width * version.height > best.width * best.height ? version : best
  ).url;
}

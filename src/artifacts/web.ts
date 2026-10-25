import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import {
  type AuthedInput,
  type Handler,
  json,
  onShareHost,
  type Route,
  type RouteInput,
} from "../app/http.ts";
import { html, page, redirect, rejectCrossOrigin } from "../app/web.ts";
import { currentUser } from "../platform/auth.ts";
import { HttpError, notFound } from "../platform/errors.ts";
import type { Viewer } from "./artifacts.ts";
import { artifactList, artifactPage, artifactPreview } from "./pages.ts";

const VISITOR_COOKIE = "golem-visitor";
/** The largest runtime call: a 64 KB value with its key, and room for JSON escapes. */
const MAX_CALL = 200_000;
/**
 * The artifact's HTML runs in a sandbox without `allow-same-origin`, so it never runs as this site: it cannot read
 * Golem's cookies or call Golem. The wrapper page's frame asks for the same sandbox.
 */
const SANDBOX =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";
/** Artifact names are two words, so they can be guessed: a client that misses this many links in a window waits. */
const MAX_MISSES = 20;
const MISS_WINDOW = 10 * 60_000;
const misses = new Map<string, { count: number; until: number }>();

/** The page of an artifact link: the artifact in a sandboxed frame. */
const linkPage: Handler = async (input) => {
  try {
    const { viewer, artifact } = await openFor(input);
    const response = html(artifactPage(artifact));
    return viewer.user || viewer.token
      ? response
      : withVisitorCookie(input, response);
  } catch (error) {
    return pageError(
      error,
      onShareHost(input) ? null : `/login?next=/a/${input.params.artifact}`
    );
  }
};

/** The artifact's HTML with its runtime, which runs without Golem's origin. */
const linkContent: Handler = async (input) => {
  try {
    const { artifact } = await openFor(input);
    return new Response(input.app.artifacts.content(artifact.id), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": SANDBOX,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return pageError(error, null);
  }
};

/** A call of the artifact's `golem` runtime, from the link's page on the same host. */
const linkCall: Handler = async (input) => {
  if (onShareHost(input)) {
    const origin = input.request.headers.get("origin");
    if (origin && origin !== input.app.config.shareUrl) {
      throw new HttpError(403, "Cross-site request");
    }
  } else {
    rejectCrossOrigin(input);
  }
  const { op, args } = await readCall(input.request);
  const { viewer, artifact } = await openFor(input);
  return json({
    result: input.app.artifacts.call(artifact.id, viewer, op, args),
  });
};

const SHARE = { share: true } as const;

/**
 * The link of an artifact, which anyone may open when it is public, and the runtime its page calls: `/a/<name>` on
 * Golem's own address, and `/<name>` on the public host of `share_url`. The Artifacts panel and preview of its place
 * open, change, and delete it: its channel and the channel's threads, or the orchestrator for the workspace's own.
 */
export const artifactWebRoutes: readonly Route[] = [
  ["GET", "/a/:artifact", linkPage],
  ["GET", "/a/:artifact/content", linkContent],
  ["POST", "/a/:artifact/rpc", linkCall],
  ["GET", "/:artifact", linkPage, SHARE],
  ["GET", "/:artifact/content", linkContent, SHARE],
  ["POST", "/:artifact/rpc", linkCall, SHARE],
  [
    "GET",
    "/w/:workspace/artifacts/:artifact",
    page(async (input) => {
      const artifact = artifactIn(input);
      const records = input.app.artifacts.dataFor(artifact.id, input.user);
      return ServerSentEventGenerator.stream((stream) => {
        stream.patchElements(
          artifactPreview(input.params.workspace!, artifact, records)
        );
        stream.patchSignals(
          JSON.stringify({ tab: "preview", artifactData: false })
        );
      });
    }),
  ],
  [
    "POST",
    "/w/:workspace/artifacts/:artifact/visibility/:visibility",
    page(async (input) => {
      rejectCrossOrigin(input);
      const artifact = input.app.artifacts.setVisibility(
        artifactIn(input).id,
        input.user,
        input.params.visibility
      );
      return panel(input, artifact.channelId, artifact.id);
    }),
  ],
  [
    "DELETE",
    "/w/:workspace/artifacts/:artifact",
    page(async (input) => {
      rejectCrossOrigin(input);
      const artifact = artifactIn(input);
      input.app.artifacts.delete(artifact.id, input.user);
      return panel(input, artifact.channelId, null);
    }),
  ],
  [
    "DELETE",
    "/w/:workspace/artifacts/:artifact/data",
    page(async (input) => {
      rejectCrossOrigin(input);
      const artifact = artifactIn(input);
      input.app.artifacts.clearData(artifact.id, input.user);
      return panel(input, artifact.channelId, artifact.id);
    }),
  ],
  [
    "DELETE",
    "/w/:workspace/artifacts/:artifact/records/:record",
    page(async (input) => {
      rejectCrossOrigin(input);
      const artifact = artifactIn(input);
      input.app.artifacts.deleteRecordFor(
        artifact.id,
        input.user,
        input.params.record!
      );
      return panel(input, artifact.channelId, artifact.id);
    }),
  ],
];

/**
 * The artifact in the path, for the request's viewer. The public host has only public artifacts. Counts the
 * client's misses, and refuses it after too many.
 */
async function openFor(input: RouteInput) {
  const share = onShareHost(input);
  // On the public host the client is the address Cloudflare saw; otherwise the address the proxy (Caddy) adds.
  const client =
    (share
      ? input.request.headers.get("cf-connecting-ip")
      : input.request.headers
          .get("x-forwarded-for")
          ?.split(",")
          .at(-1)
          ?.trim()) ?? "direct";
  const now = Date.now();
  const missed = misses.get(client);
  const current =
    missed && missed.until > now
      ? missed
      : { count: 0, until: now + MISS_WINDOW };
  if (current.count >= MAX_MISSES) {
    throw new HttpError(
      429,
      "Too many links that do not exist; try again later"
    );
  }
  const viewer = await viewerOf(input);
  try {
    const artifact = input.app.artifacts.open(input.params.artifact!, viewer);
    if (share && artifact.visibility !== "public") {
      throw notFound();
    }
    return { viewer, artifact };
  } catch (error) {
    // The public host does not tell a members artifact from a missing one.
    const missing =
      error instanceof HttpError &&
      (error.status === 404 || (share && error.status === 401));
    if (missing) {
      current.count += 1;
      if (misses.size > 10_000) {
        misses.clear();
      }
      misses.set(client, current);
      throw notFound();
    }
    throw error;
  }
}

/** A signed-in person, or a public visitor with the token of their browser. */
async function viewerOf({ app, request }: RouteInput): Promise<Viewer> {
  const user = await currentUser(app.auth, request);
  if (user) {
    return { user };
  }
  const token = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
    VISITOR_COOKIE
  );
  return token ? { token } : {};
}

/** Gives a public visitor a token, which their calls send back; the runtime keeps their data under its hash. */
function withVisitorCookie(input: RouteInput, response: Response): Response {
  const share = onShareHost(input);
  const { baseUrl, shareUrl } = input.app.config;
  const cookie = new Bun.Cookie(
    VISITOR_COOKIE,
    crypto.getRandomValues(Buffer.alloc(24)).toString("base64url"),
    {
      // The public host serves only artifacts, at its root.
      path: share ? "/" : "/a/",
      httpOnly: true,
      sameSite: "lax",
      secure: ((share ? shareUrl : null) ?? baseUrl).startsWith("https:"),
      maxAge: 60 * 60 * 24 * 365 * 2,
    }
  );
  response.headers.append("set-cookie", cookie.serialize());
  return response;
}

/** A signed-out person signs in for a members artifact; others see not found. */
function pageError(error: unknown, signIn: string | null): Response {
  if (error instanceof HttpError && error.status === 401 && signIn) {
    return redirect(signIn);
  }
  if (error instanceof HttpError && [401, 404].includes(error.status)) {
    return new Response("Not found", { status: 404 });
  }
  if (error instanceof HttpError && error.status === 429) {
    return new Response(error.message, { status: 429 });
  }
  throw error;
}

async function readCall(
  request: Request
): Promise<{ op: unknown; args: unknown }> {
  const text = await request.text();
  if (text.length > MAX_CALL) {
    throw new HttpError(413, "The call is too large");
  }
  const body = await Promise.resolve()
    .then(() => JSON.parse(text))
    .catch(() => null);
  if (typeof body !== "object" || body === null) {
    throw new HttpError(400, "Send a JSON object");
  }
  return body;
}

/** An artifact of the workspace in the path, for a member. */
function artifactIn(input: AuthedInput) {
  const { app, user, params } = input;
  const artifact = app.artifacts.get(params.artifact!, user);
  const place = app.artifacts.inPlace(
    params.workspace!,
    artifact.channelId,
    user
  );
  if (!place.some((candidate) => candidate.id === artifact.id)) {
    throw notFound();
  }
  return artifact;
}

/** The Artifacts list of a place and the preview, with `artifactId` open or empty. */
function panel(
  input: AuthedInput,
  channelId: string | null,
  artifactId: string | null
): Response {
  const { app, user, params } = input;
  const artifacts = app.artifacts.inPlace(params.workspace!, channelId, user);
  const artifact = artifacts.find((candidate) => candidate.id === artifactId);
  return ServerSentEventGenerator.stream((stream) => {
    stream.patchElements(artifactList(params.workspace!, artifacts));
    stream.patchElements(
      artifactPreview(
        params.workspace!,
        artifact ?? null,
        artifact ? app.artifacts.dataFor(artifact.id, user) : []
      )
    );
    if (!artifact) {
      stream.patchSignals(JSON.stringify({ tab: "artifacts" }));
    }
  });
}

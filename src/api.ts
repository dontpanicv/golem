import {
  type AuthedInput,
  type Handler,
  json,
  type Route,
  signedIn,
  withCookies,
} from "./app.ts";
import { HttpError } from "./workspaces.ts";

/** The JSON API for the iOS app. See docs/api.md. */
export const apiRoutes: readonly Route[] = [
  ["*", "/api/auth/*", ({ app, request }) => app.auth.handler(request)],
  // The iOS app opens these in a browser sheet: Google sign-in, then `golem://signed-in` with a token or an error.
  // Any app can claim `golem://`, so only a sign-in started here hands over a token, and Google always asks.
  [
    "GET",
    "/api/v1/sign-in/google",
    async ({ app }) => {
      const done = "/api/v1/sign-in/google/done";
      const google = await app.auth.api.signInSocial({
        body: {
          provider: "google",
          callbackURL: done,
          errorCallbackURL: done,
          additionalParams: { prompt: "select_account" },
        },
        returnHeaders: true,
      });
      const response = withCookies(google, google.response.url!);
      response.headers.append(
        "set-cookie",
        `${APP_SIGN_IN}=1; Path=/api/v1/sign-in/google; Max-Age=600; HttpOnly; SameSite=Lax`
      );
      return response;
    },
  ],
  [
    "GET",
    "/api/v1/sign-in/google/done",
    async ({ app, request }) => {
      const started = request.headers
        .get("cookie")
        ?.split("; ")
        .includes(`${APP_SIGN_IN}=1`);
      const session = started
        ? await app.auth.api.getSession({ headers: request.headers })
        : null;
      const params = new URL(request.url).searchParams;
      const result: Record<string, string> = session
        ? { token: session.session.token }
        : {
            error:
              params.get("error_description") ??
              params.get("error") ??
              "Sign-in failed",
          };
      const headers = new Headers({
        location: `golem://signed-in?${new URLSearchParams(result)}`,
      });
      headers.append(
        "set-cookie",
        `${APP_SIGN_IN}=; Path=/api/v1/sign-in/google; Max-Age=0`
      );
      return new Response(null, { status: 303, headers });
    },
  ],

  [
    "GET",
    "/api/v1/me",
    api(async ({ app, user }) =>
      json({ user, workspaces: app.workspaces.list(user) })
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces",
    api(async ({ app, user, body }) =>
      json(await app.workspaces.create(user, body.name as string))
    ),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace",
    api(async ({ app, user, params }) =>
      json({
        workspace: app.workspaces.get(params.workspace!, user),
        channels: app.workspaces.channels(params.workspace!, user),
      })
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/channels",
    api(async ({ app, user, params, body }) =>
      json(
        app.workspaces.createChannel(
          params.workspace!,
          user,
          body.name as string
        )
      )
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/threads",
    api(async ({ app, user, params, body }) =>
      json(
        await app.workspaces.createThread(
          params.workspace!,
          user,
          body.channelId as string,
          body.text as string
        )
      )
    ),
  ],
  [
    "GET",
    "/api/v1/threads/:thread",
    api(async ({ app, user, params }) => {
      const thread = app.workspaces.thread(params.thread!, user);
      return json({
        thread: summary(thread),
        ...(await app.threads.messages(thread)),
      });
    }),
  ],
  [
    "GET",
    "/api/v1/threads/:thread/events",
    api(async ({ app, user, params }) => {
      const thread = app.workspaces.thread(params.thread!, user);
      return eventStream((send) =>
        app.threads.watch(thread, (state) =>
          send("thread", { thread: summary(thread), ...state })
        )
      );
    }),
  ],
  [
    "POST",
    "/api/v1/threads/:thread/messages",
    api(async ({ app, user, params, body }) => {
      await app.workspaces.send(params.thread!, user, body.text as string);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/search",
    api(async ({ app, user, params, request }) => {
      // Membership first: a workspace's index is only ever searched by its members.
      const workspace = app.workspaces.get(params.workspace!, user);
      const url = new URL(request.url);
      const limit = Math.min(
        Math.max(Number(url.searchParams.get("limit")) || 20, 1),
        50
      );
      return json(
        await app.indexer.search(
          workspace.id,
          url.searchParams.get("q") ?? "",
          limit
        )
      );
    }),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/members",
    api(async ({ app, user, params }) =>
      json(app.workspaces.members(params.workspace!, user))
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/members",
    api(async ({ app, user, params, body }) =>
      json(
        await app.workspaces.addMember(
          params.workspace!,
          user,
          body.email as string
        )
      )
    ),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/integrations",
    api(async ({ app, user, params }) =>
      json(app.workspaces.integrations(params.workspace!, user))
    ),
  ],
  [
    "PUT",
    "/api/v1/workspaces/:workspace/integrations/:integration",
    api(async ({ app, user, params, body }) =>
      json(
        app.workspaces.setEnabled(
          params.workspace!,
          user,
          params.integration!,
          body.enabled === true
        )
      )
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/integrations/:integration/credentials",
    api(async ({ app, user, params, body }) =>
      json(
        app.workspaces.addCredential(
          params.workspace!,
          user,
          params.integration!,
          {
            label: body.label as string,
            secret: body.secret as string,
            shared: body.shared === true,
          }
        )
      )
    ),
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace/credentials/:credential",
    api(async ({ app, user, params }) => {
      app.workspaces.deleteCredential(
        params.workspace!,
        user,
        params.credential!
      );
      return new Response(null, { status: 204 });
    }),
  ],
  ["GET", "/api/v1/llm", api(async ({ app }) => json(await app.llm.status()))],
  [
    "POST",
    "/api/v1/llm/login",
    api(async ({ app }) => json(await app.llm.startLogin())),
  ],
  [
    "POST",
    "/api/v1/llm/logout",
    api(async ({ app }) => json(await app.llm.logout())),
  ],
  [
    "PUT",
    "/api/v1/llm/model",
    api(async ({ app, body }) => {
      app.llm.setModel(body.model as string);
      return json(await app.llm.status());
    }),
  ],
  [
    "PUT",
    "/api/v1/llm/effort",
    api(async ({ app, body }) => {
      app.llm.setEffort(body.effort as string);
      return json(await app.llm.status());
    }),
  ],
];

const APP_SIGN_IN = "golem_app_sign_in";

type ApiInput = AuthedInput & { readonly body: Record<string, unknown> };

function api(handler: (input: ApiInput) => Promise<Response>): Handler {
  return signedIn(
    async (input) => {
      const body =
        input.request.method === "GET" || input.request.method === "DELETE"
          ? {}
          : await readBody(input.request);
      return handler({ ...input, body });
    },
    () => json({ error: "Sign in first" }, 401)
  );
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  const body = await Promise.resolve()
    .then(() => JSON.parse(text))
    .catch(() => undefined);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Send a JSON object");
  }
  return body as Record<string, unknown>;
}

function summary(thread: {
  id: string;
  channelId: string;
  title: string;
  updatedAt: number;
}) {
  return {
    id: thread.id,
    channelId: thread.channelId,
    title: thread.title,
    updatedAt: thread.updatedAt,
  };
}

/** A server-sent events response that runs until the client disconnects. */
export function eventStream(
  start: (
    send: (event: string, data: unknown) => void
  ) => Promise<() => Promise<void>>
): Response {
  const encoder = new TextEncoder();
  let stop: (() => Promise<void>) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      stop = await start(send);
      // Comments keep proxies and idle timers from closing a quiet stream.
      ping = setInterval(
        () => controller.enqueue(encoder.encode(": ping\n\n")),
        15_000
      );
    },
    async cancel() {
      clearInterval(ping);
      await stop?.();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

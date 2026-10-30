import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { serializeSignedCookie } from "better-call";
import { HttpRouter } from "effect/http";
import { type App, closeApp, createApp } from "../src/app/app.ts";
import { routes } from "../src/app/http.ts";
import { allRoutes } from "../src/app/routes.ts";
import { Secrets } from "../src/platform/secrets.ts";

export interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export type TestApp = Awaited<ReturnType<typeof startTestApp>>;

/**
 * A Golem server in a temporary folder with the faux LLM provider; alice, bob, and eve may sign in.
 *
 * @example
 * const golem = await startTestApp();
 * const alice = await golem.signIn("Alice", "alice@example.com");
 * const me = await golem.call("/api/v1/me", { token: alice });
 * await golem.close();
 */
export async function startTestApp() {
  const faux = fauxProvider();
  const model = faux.getModel();
  const dataDirectory = await mkdtemp(join(tmpdir(), "golem-"));
  const app: App = await createApp(
    {
      configDirectory: dataDirectory,
      dataDirectory,
      host: "127.0.0.1",
      port: 0,
      baseUrl: "http://golem.test",
      shareUrl: "http://share.golem.test",
      allowedEmails: [
        "alice@example.com",
        "bob@example.com",
        "eve@example.com",
      ],
      google: {
        clientId: "test-client.apps.googleusercontent.com",
        clientSecret: "test-secret",
      },
      iosAppId: "ABCDE12345.dev.golem.test",
      apns: null,
    },
    { provider: faux.provider, name: "Test model", defaultModel: model.id },
    Secrets.forTests()
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes(app, allRoutes), {
    disableLogger: true,
  });

  function call(path: string, options: CallOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (options.token) {
      headers.set("authorization", `Bearer ${options.token}`);
    }
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    return handler(
      new Request(`http://golem.test${path}`, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    );
  }

  /** What a Google sign-in does after Google confirms the email: makes the user on first sign-in, then a session. */
  async function signIn(name: string, email: string): Promise<string> {
    const { internalAdapter } = await app.auth.$context;
    const user =
      (await internalAdapter.findUserByEmail(email))?.user ??
      (await internalAdapter.createUser(
        { name, email, emailVerified: true },
        { method: "oauth", oauth: { providerId: "google" } }
      ));
    return (await internalAdapter.createSession(user.id)).token;
  }

  /** The session cookie value for a token, signed as better-auth signs it. */
  async function signedCookie(token: string): Promise<string> {
    const { secret } = await app.auth.$context;
    return (await serializeSignedCookie("", token, secret)).slice(1);
  }

  /** The `cookie` header a browser sends for a signed-in session. */
  async function sessionCookie(token: string): Promise<string> {
    return `better-auth.session_token=${await signedCookie(token)}`;
  }

  async function close(): Promise<void> {
    await dispose();
    await closeApp(app);
    await rm(dataDirectory, { recursive: true, force: true });
  }

  return {
    app,
    dataDirectory,
    faux,
    model,
    handler,
    call,
    signIn,
    signedCookie,
    sessionCookie,
    close,
  };
}

export function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

export async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    await Bun.sleep(20);
  }
  throw new Error("Timed out");
}

/** A faux model's call of a namespaced tool, which the model reaches only through a codemode script. */
export function scriptCall(name: string, args: object) {
  return fauxToolCall("codemode", {
    code: `text(await tools.${name}(${JSON.stringify(args)}));`,
  });
}

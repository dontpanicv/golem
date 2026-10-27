import { afterAll, beforeAll, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { cookies, startTestApp, type TestApp, until } from "./harness.ts";

let golem: TestApp;
let app: TestApp["app"];
let call: TestApp["call"];
let handler: TestApp["handler"];
let signIn: TestApp["signIn"];
let signedCookie: TestApp["signedCookie"];

beforeAll(async () => {
  golem = await startTestApp();
  ({ app, call, handler, signIn, signedCookie } = golem);
});

afterAll(() => golem.close());

let alice: string;
let bob: string;
let workspaceId: string;
let threadId: string;

test("only allowed emails sign in, and only with Google", async () => {
  alice = await signIn("Alice", "alice@example.com");
  bob = await signIn("Bob", "bob@example.com");
  await expect(signIn("Mallory", "mallory@example.com")).rejects.toThrow(
    "cannot sign in"
  );
  // Someone whose email left the list keeps no access.
  app.database.run(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('old', 'Old', 'old@example.com', 1, 0, 0)"
  );
  await expect(signIn("Old", "old@example.com")).rejects.toThrow(
    "cannot sign in"
  );
  // A session made before the email left the list signs in nobody, and better-auth's routes refuse it.
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  app.database
    .query(
      "INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt) VALUES ('old-session', 'old-token', 'old', ?, ?, ?)"
    )
    .run(later, now, now);
  expect((await call("/api/v1/me", { token: "old-token" })).status).toBe(401);
  expect(
    (await call("/api/auth/get-session", { token: "old-token" })).status
  ).toBe(401);
  expect(
    (await call("/api/auth/organization/list", { token: "old-token" })).status
  ).toBe(401);

  const body = {
    name: "Mallory",
    email: "mallory@example.com",
    password: "correct horse battery",
  };
  expect((await call("/api/auth/sign-up/email", { body })).status).not.toBe(
    200
  );
  expect((await call("/api/auth/sign-in/email", { body })).status).not.toBe(
    200
  );
  expect((await call("/api/v1/me")).status).toBe(401);
  expect((await call("/api/v1/me", { token: alice })).status).toBe(200);
});

test("the iOS app gets a token only for a Google sign-in it started, with its verifier, once", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  // RFC 7636, appendix B.
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  expect((await call("/api/v1/sign-in/google")).status).toBe(400);
  const begin = async () => {
    const start = await call(`/api/v1/sign-in/google?challenge=${challenge}`);
    expect(
      new URL(start.headers.get("location")!).searchParams.get("prompt")
    ).toBe("select_account");
    const flow = /golem_app_sign_in=([\w-]+)/.exec(cookies(start))![1]!;
    return `golem_app_sign_in=${flow}`;
  };
  const done = async (cookie: string, query = "") => {
    const response = await call(`/api/v1/sign-in/google/done${query}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!, "http://x");
    expect(location.pathname).toBe("/api/v1/sign-in/google/signed-in");
    return location.searchParams;
  };
  const swap = async (
    given: string | null,
    withVerifier = verifier
  ): Promise<Record<string, unknown>> => {
    const response = await call("/api/v1/sign-in/google/token", {
      body: { code: given, verifier: withVerifier },
    });
    return {
      status: response.status,
      ...((await response.json()) as Record<string, unknown>),
    };
  };
  const session = async (token: string) =>
    `better-auth.session_token=${await signedCookie(token)}`;

  // A session that the browser had before the sign-in started gets nothing.
  const older = await done(`${await session(alice)}; ${await begin()}`);
  expect(older.get("code")).toBeNull();
  expect(older.get("error")).toBe("Sign-in failed");
  // Nor does a session without a sign-in that started here.
  expect((await done(await session(alice))).get("code")).toBeNull();

  // The session that the sign-in's Google step made gives a code, which gives its token once, for the verifier.
  const flow = await begin();
  const fresh = await signIn("Alice", "alice@example.com");
  const code = (await done(`${await session(fresh)}; ${flow}`)).get("code");
  expect(code).toBeString();
  expect(await swap(code)).toEqual({ status: 200, token: fresh });
  expect(await swap(code)).toEqual({ status: 400, error: "Sign in again" });
  // The flow ended with its code.
  expect(
    (await done(`${await session(fresh)}; ${flow}`)).get("code")
  ).toBeNull();

  // Another app that catches a code has no verifier, and the code is gone after one try.
  const caught = await begin();
  const other = await signIn("Alice", "alice@example.com");
  const stolen = (await done(`${await session(other)}; ${caught}`)).get("code");
  expect(await swap(stolen, "x".repeat(43))).toEqual({
    status: 400,
    error: "Sign in again",
  });
  expect(await swap(stolen)).toEqual({ status: 400, error: "Sign in again" });

  const failed = await done(
    await begin(),
    "?error=EMAIL_NOT_ALLOWED&error_description=No"
  );
  expect(failed.toString()).toBe("error=No");

  // A browser without the app shows a page at the address where the sign-in ends.
  const page = await call("/api/v1/sign-in/google/signed-in?code=x");
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await page.text()).toContain("Open the Golem app");
  const association = await call("/.well-known/apple-app-site-association");
  expect(association.headers.get("content-type")).toStartWith(
    "application/json"
  );
  expect(await association.json()).toEqual({
    webcredentials: { apps: ["ABCDE12345.dev.golem.test"] },
  });
});

test("a new workspace has a general channel", async () => {
  const workspace = (await (
    await call("/api/v1/workspaces", { token: alice, body: { name: "Family" } })
  ).json()) as any;
  workspaceId = workspace.id;
  const detail = (await (
    await call(`/api/v1/workspaces/${workspaceId}`, { token: alice })
  ).json()) as any;
  expect(
    detail.channels.map((channel: { name: string }) => channel.name)
  ).toEqual(["general"]);
  const duplicate = await call(`/api/v1/workspaces/${workspaceId}/channels`, {
    token: alice,
    body: { name: "General" },
  });
  expect(duplicate.status).toBe(409);
});

test("a thread is a Pi Durable session that knows who wrote each message", async () => {
  golem.faux.setResponses([fauxAssistantMessage("Saturday works.")]);
  const { channels } = (await (
    await call(`/api/v1/workspaces/${workspaceId}`, { token: alice })
  ).json()) as any;
  const thread = (await (
    await call(`/api/v1/workspaces/${workspaceId}/threads`, {
      token: alice,
      body: { channelId: channels[0].id, text: "Plan the cabin trip" },
    })
  ).json()) as any;
  threadId = thread.id;
  expect(thread.title).toBe("Plan the cabin trip");
  const state = await until(
    async () =>
      (
        await call(`/api/v1/threads/${threadId}`, { token: alice })
      ).json() as any,
    (current) => current.messages.length === 2 && !current.running
  );
  expect(
    state.messages.map((message: { author: string; text: string }) => [
      message.author,
      message.text,
    ])
  ).toEqual([
    ["Alice", "Plan the cabin trip"],
    ["Golem", "Saturday works."],
  ]);
});

test("workspaces are isolated until someone adds you", async () => {
  expect(
    (await call(`/api/v1/workspaces/${workspaceId}`, { token: bob })).status
  ).toBe(404);
  expect(
    (await call(`/api/v1/threads/${threadId}`, { token: bob })).status
  ).toBe(404);
  expect(
    (
      await call(`/api/v1/threads/${threadId}/messages`, {
        token: bob,
        body: { text: "hi" },
      })
    ).status
  ).toBe(404);
  expect(
    ((await (await call("/api/v1/me", { token: bob })).json()) as any)
      .workspaces
  ).toEqual([]);

  const added = await call(`/api/v1/workspaces/${workspaceId}/members`, {
    token: alice,
    body: { email: "BOB@example.com" },
  });
  expect(added.status).toBe(200);
  expect(
    (await call(`/api/v1/threads/${threadId}`, { token: bob })).status
  ).toBe(200);
});

test("credentials belong to the workspace, and secrets never leave the server", async () => {
  const base = `/api/v1/workspaces/${workspaceId}`;
  const credential = (await (
    await call(`${base}/integrations/github/credentials`, {
      token: alice,
      body: { label: "Family", secret: "family-secret" },
    })
  ).json()) as any;

  const bobsView = await (
    await call(`${base}/integrations`, { token: bob })
  ).text();
  expect(bobsView).toContain("Family");
  expect(bobsView).not.toContain("family-secret");

  // Any member deletes a credential of the workspace.
  expect(
    (
      await call(`${base}/credentials/${credential.id}`, {
        method: "DELETE",
        token: bob,
      })
    ).status
  ).toBe(204);
  expect(
    (
      await call(`${base}/credentials/${credential.id}`, {
        method: "DELETE",
        token: alice,
      })
    ).status
  ).toBe(404);
  // The credential stays encrypted, marked deleted, and no tool reads it.
  expect(
    golem.app.database
      .query(
        "SELECT deleted_at IS NOT NULL AS deleted FROM credential WHERE id = ?"
      )
      .get(credential.id)
  ).toEqual({ deleted: 1 });
});

test("only the server's owner restarts Golem", async () => {
  const refused = await call("/api/v1/server/restart", {
    method: "POST",
    token: bob,
    body: {},
  });
  expect(refused.status).toBe(403);
});

test("everyone uses the one LLM provider, and only the server's owner changes it", async () => {
  const llm = (await (await call("/api/v1/llm", { token: bob })).json()) as any;
  // The faux model has no reasoning, so the default effort moves to the one level it supports.
  expect(llm).toMatchObject({
    provider: "Test model",
    model: golem.model.id,
    effort: "off",
    models: [{ id: golem.model.id, name: golem.model.name, efforts: ["off"] }],
    login: null,
    owner: false,
  });
  for (const [path, method, body] of [
    ["/api/v1/llm/model", "PUT", { model: golem.model.id }],
    ["/api/v1/llm/effort", "PUT", { effort: "off" }],
    ["/api/v1/llm/login", "POST", {}],
    ["/api/v1/llm/logout", "POST", {}],
  ] as const) {
    const refused = await call(path, { method, token: bob, body });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Only the server's owner changes this",
    });
  }
  // Alice's email is the first in allowed_emails.
  expect(
    await (await call("/api/v1/llm", { token: alice })).json()
  ).toMatchObject({ owner: true });
  expect(
    (
      await call("/api/v1/llm/model", {
        method: "PUT",
        token: alice,
        body: { model: "nope" },
      })
    ).status
  ).toBe(400);
  expect(
    (
      await call("/api/v1/llm/effort", {
        method: "PUT",
        token: alice,
        body: { effort: "high" },
      })
    ).status
  ).toBe(400);
  expect(
    await (
      await call("/api/v1/llm/effort", {
        method: "PUT",
        token: alice,
        body: { effort: "off" },
      })
    ).json()
  ).toMatchObject({ effort: "off", owner: true });
});

test("the web app signs in with Google and keeps cross-site posts out", async () => {
  // Behind a TLS proxy the request arrives at the internal address, with the browser's origin.
  const login = await handler(
    new Request("http://127.0.0.1:3000/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        origin: "http://golem.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    })
  );
  expect(login.status).toBe(200);
  const google = new URL(((await login.json()) as { url: string }).url);
  expect(google.origin).toBe("https://accounts.google.com");
  expect(google.searchParams.get("redirect_uri")).toBe(
    "http://golem.test/api/auth/callback/google"
  );
  expect(cookies(login)).toContain("state");

  const cookie = `better-auth.session_token=${await signedCookie(alice)}`;
  const crossSite = await handler(
    new Request(`http://golem.test/api/v1/workspaces/${workspaceId}/channels`, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "pwned" }),
    })
  );
  expect(crossSite.status).toBe(403);
  expect(
    (await call(`/api/v1/threads/${threadId}`, { headers: { cookie } })).status
  ).toBe(200);
});

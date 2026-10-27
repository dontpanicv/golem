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

test("the iOS app gets a token only from a Google sign-in it started", async () => {
  const start = await call("/api/v1/sign-in/google");
  expect(
    new URL(start.headers.get("location")!).searchParams.get("prompt")
  ).toBe("select_account");
  expect(cookies(start)).toContain("golem_app_sign_in=1");

  const session = `better-auth.session_token=${await signedCookie(alice)}`;
  const started = await call("/api/v1/sign-in/google/done", {
    headers: { cookie: `${session}; golem_app_sign_in=1` },
  });
  expect(
    new URL(started.headers.get("location")!).searchParams.get("token")
  ).toBe(alice);
  const notStarted = await call("/api/v1/sign-in/google/done", {
    headers: { cookie: session },
  });
  expect(
    new URL(notStarted.headers.get("location")!).searchParams.get("token")
  ).toBeNull();
  const failed = await call(
    "/api/v1/sign-in/google/done?error=EMAIL_NOT_ALLOWED&error_description=No",
    { headers: { cookie: "golem_app_sign_in=1" } }
  );
  expect(failed.headers.get("location")).toBe("golem://signed-in?error=No");
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

test("the LLM provider is shared by everyone", async () => {
  const llm = (await (await call("/api/v1/llm", { token: bob })).json()) as any;
  // The faux model has no reasoning, so the default effort moves to the one level it supports.
  expect(llm).toMatchObject({
    provider: "Test model",
    model: golem.model.id,
    effort: "off",
    models: [{ id: golem.model.id, name: golem.model.name, efforts: ["off"] }],
    login: null,
  });
  expect(
    (
      await call("/api/v1/llm/model", {
        method: "PUT",
        token: bob,
        body: { model: "nope" },
      })
    ).status
  ).toBe(400);
  expect(
    (
      await call("/api/v1/llm/effort", {
        method: "PUT",
        token: bob,
        body: { effort: "high" },
      })
    ).status
  ).toBe(400);
  expect(
    await (
      await call("/api/v1/llm/effort", {
        method: "PUT",
        token: bob,
        body: { effort: "off" },
      })
    ).json()
  ).toMatchObject({ effort: "off" });
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

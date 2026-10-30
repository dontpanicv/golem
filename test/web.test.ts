import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { $ } from "bun";
import { clientKey } from "../src/artifacts/web.ts";
import type { User } from "../src/platform/auth.ts";
import type { ThreadRef } from "../src/workspaces/workspaces.ts";
import { cookies, startTestApp, type TestApp, until } from "./harness.ts";

function location(response: Response): string | null {
  return response.headers.get("location");
}

describe("the web app", () => {
  let golem: TestApp;
  let alice: User;
  let aliceCookie: string;
  let bobCookie: string;
  let workspaceId: string;
  let generalId: string;
  let thread: ThreadRef;

  beforeAll(async () => {
    await $`bun run build`.quiet();
    golem = await startTestApp();
    aliceCookie = await golem.sessionCookie(
      await golem.signIn("Alice", "alice@example.com")
    );
    bobCookie = await golem.sessionCookie(
      await golem.signIn("Bob", "bob@example.com")
    );
    alice = golem.app.database
      .query("SELECT id, name, email FROM user WHERE email = ?")
      .get("alice@example.com") as User;
    const workspace = await golem.app.workspaces.create(alice, "Family");
    workspaceId = workspace.id;
    generalId = golem.app.workspaces.channels(workspaceId, alice)[0]!.id;
    const summary = await golem.app.threads.create(
      workspaceId,
      alice,
      generalId,
      "Plan the trip"
    );
    thread = golem.app.workspaces
      .allThreadsIn(workspaceId)
      .find((candidate) => candidate.id === summary.id)!;
  });

  afterAll(() => golem.close());

  test("every page of the app is the app's page, which the browser checks every time; its files stay for good", async () => {
    for (const path of [
      "/",
      "/login",
      "/settings",
      "/workspaces/new",
      `/w/${workspaceId}/t/${thread.id}`,
    ]) {
      const page = await golem.call(path);
      expect([path, page.status]).toEqual([path, 200]);
      expect(page.headers.get("cache-control")).toBe("no-cache");
      const policy = page.headers.get("content-security-policy")!;
      expect(policy).toContain("img-src 'self' data: blob:");
      expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(policy).toContain("frame-ancestors 'none'");
      const html = await page.text();
      expect(html).toContain('<div id="root"></div>');
      const script = /src="(\/app\/[^"]+\.js)"/.exec(html)![1]!;
      const file = await golem.call(script, {
        headers: { "accept-encoding": "gzip, br" },
      });
      expect(file.headers.get("cache-control")).toContain("immutable");
      expect(file.headers.get("content-encoding")).toBe("gzip");
    }
    expect((await golem.call("/nothing-here")).status).toBe(404);
    expect((await golem.call("/app/..%2F..%2Fpackage.json")).status).toBe(404);
  });

  test("the JSON API takes the session cookie only from Golem's own origin", async () => {
    const me = await golem.call("/api/v1/me", {
      headers: { cookie: aliceCookie },
    });
    expect(await me.json()).toMatchObject({ user: { name: "Alice" } });
    const create = (origin: string) =>
      golem.call(`/api/v1/workspaces/${workspaceId}/channels`, {
        body: { name: `from-${new URL(origin).hostname.split(".")[0]}` },
        headers: { cookie: aliceCookie, origin },
      });
    expect((await create("https://evil.example")).status).toBe(403);
    expect((await create("http://golem.test")).status).toBe(200);
    expect((await golem.call("/api/v1/me")).status).toBe(401);
  });

  test("an artifact link runs the artifact in a sandbox, for anyone when public and for members otherwise", async () => {
    const artifact = golem.app.artifacts.create(thread, generalId, {
      title: "Trip <dates>",
      html: "<!doctype html><html><head></head><body>Vote</body></html>",
      visibility: "public",
      requestKey: "web-test",
    });
    const link = `/a/${artifact.id}`;

    const opened = await golem.call(link);
    const page = await opened.text();
    expect(page).toContain("<title>Trip &lt;dates&gt;</title>");
    expect(page).toContain(
      '<meta property="og:title" content="Trip &lt;dates&gt;">'
    );
    expect(page).toContain(
      `<iframe src="${artifact.id}/content?v=${artifact.updatedAt}"`
    );
    expect(page).toContain(
      'sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"'
    );
    const visitor = cookies(opened);
    expect(visitor).toStartWith("golem-visitor=");
    expect(opened.headers.get("set-cookie")).toContain("Path=/a/");
    expect(opened.headers.get("set-cookie")).toContain("HttpOnly");

    const content = await golem.call(`${link}/content`);
    const policy = content.headers.get("content-security-policy")!;
    expect(policy).toStartWith("sandbox allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain("; img-src data: blob:;");
    expect(policy).toContain("connect-src 'none'");
    expect(page).toContain("new MessageChannel()");
    const text = await content.text();
    expect(text).toContain("window.golem = golem");
    expect(text).toContain("event.ports");

    const call = (body: unknown, headers: Record<string, string>) =>
      golem.call(`${link}/rpc`, { body, headers });
    const me = await call(
      { op: "me", args: {} },
      { cookie: visitor, origin: "http://golem.test" }
    );
    expect(await me.json()).toMatchObject({
      result: { name: null, member: false },
    });
    expect(
      (
        await call(
          { op: "set", args: { scope: "mine", key: "vote", value: 1 } },
          { cookie: visitor, origin: "https://evil.example" }
        )
      ).status
    ).toBe(403);
    expect((await call({ op: "me", args: {} }, {})).status).toBe(403);

    golem.app.artifacts.setVisibility(artifact.id, alice, "members");
    // The app's sign-in page comes back to the artifact.
    expect(location(await golem.call(link))).toBe(`/login?next=${link}`);
    expect((await golem.call(`${link}/content`)).status).toBe(404);
    const as = (cookie: string) => golem.call(link, { headers: { cookie } });
    expect((await as(bobCookie)).status).toBe(404);
    expect((await as(aliceCookie)).status).toBe(200);
  });

  test("the public host serves only public artifacts at /<name>, and nothing else", async () => {
    const make = (visibility: "public" | "members") =>
      golem.app.artifacts.create(thread, generalId, {
        title: "Share",
        html: "<p>Hi</p>",
        visibility,
        requestKey: `share-${visibility}`,
      });
    const open = make("public");
    const closed = make("members");
    expect(open.url).toBe(`http://share.golem.test/${open.id}`);
    expect(closed.url).toBe(`http://golem.test/a/${closed.id}`);
    const share = (path: string, init: RequestInit = {}) =>
      golem.handler(new Request(`http://share.golem.test${path}`, init));

    const page = await share(`/${open.id}`);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain(`<iframe src="${open.id}/content?v=`);
    expect(text).toContain(`data-rpc="${open.id}/rpc"`);
    expect(page.headers.get("set-cookie")).toContain("Path=/;");
    const visitor = cookies(page);
    const content = await share(`/${open.id}/content`);
    expect(content.headers.get("content-security-policy")).toStartWith(
      "sandbox allow-scripts"
    );
    const call = (origin: string) =>
      share(`/${open.id}/rpc`, {
        method: "POST",
        headers: {
          cookie: visitor,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ op: "me", args: {} }),
      });
    expect((await call("http://share.golem.test")).status).toBe(200);
    expect((await call("http://golem.test")).status).toBe(403);

    const script = /src="(\/app\/[^"]+\.js)"/.exec(
      await (await golem.call("/")).text()
    )![1]!;
    for (const path of [
      `/${closed.id}`,
      `/${closed.id}/content`,
      `/a/${open.id}`,
      "/",
      "/login",
      "/api/v1/me",
      `/w/${workspaceId}`,
      "/assets/styles.css",
      script,
    ]) {
      expect([
        path,
        (await share(path, { headers: { cookie: aliceCookie } })).status,
      ]).toEqual([path, 404]);
    }
    expect(
      (
        await share(`/${closed.id}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "me", args: {} }),
        })
      ).status
    ).toBe(404);
    expect((await golem.call(`/${open.id}`)).status).toBe(404);
    expect((await golem.call(`/a/${open.id}`)).status).toBe(200);
    golem.app.artifacts.delete(open.id, alice);
    golem.app.artifacts.delete(closed.id, alice);
  });

  test("a client that tries many artifact links that do not exist waits", async () => {
    const from = (address: string) => ({ "x-forwarded-for": address });
    for (let miss = 0; miss < 20; miss += 1) {
      const response = await golem.call(`/a/amber-guess${miss}`, {
        headers: from("203.0.113.7"),
      });
      expect(response.status).toBe(404);
    }
    const [artifact] = golem.app.artifacts.inPlace(
      workspaceId,
      generalId,
      alice
    );
    const refused = await golem.call(`/a/${artifact!.id}/content`, {
      headers: from("203.0.113.7"),
    });
    expect(refused.status).toBe(429);
    expect(
      (
        await golem.call(`/a/${artifact!.id}/rpc`, {
          body: { op: "me", args: {} },
          headers: from("203.0.113.7"),
        })
      ).status
    ).toBe(429);
    expect(
      (await golem.call("/a/amber-guess", { headers: from("203.0.113.8") }))
        .status
    ).toBe(404);
    const large = (address: string) =>
      golem.call("/a/amber-guess/rpc", {
        body: { op: "me", args: { padding: "x".repeat(2 * 1024 ** 2) } },
        headers: from(address),
      });
    // An IPv6 client can pick any address of its /48 network, so the network counts.
    for (let miss = 0; miss < 20; miss += 1) {
      await golem.call(`/a/amber-guess${miss}`, {
        headers: from(`2001:db8:7:${miss}::1`),
      });
    }
    expect(
      (
        await golem.call("/a/amber-guess", {
          headers: from("2001:db8:7:ff::2"),
        })
      ).status
    ).toBe(429);
    // A members link tells a signed-out client that its name exists, so it counts too.
    const members = golem.app.artifacts.create(thread, generalId, {
      title: "Members",
      html: "<p>M</p>",
      requestKey: "web-members-miss",
    });
    for (let miss = 0; miss < 20; miss += 1) {
      expect(
        (
          await golem.call(`/a/${members.id}`, {
            headers: from("203.0.113.30"),
          })
        ).status
      ).toBe(303);
    }
    expect(
      (await golem.call(`/a/${members.id}`, { headers: from("203.0.113.30") }))
        .status
    ).toBe(429);
    // A full limiter pushes out its oldest clients only: the client that waits, which came later, still waits.
    for (let client = 0; client < 9998; client += 1) {
      await golem.call("/a/amber-guess", {
        headers: from(`198.18.${Math.floor(client / 256)}.${client % 256}`),
      });
    }
    expect(
      (await golem.call("/a/amber-guess", { headers: from("203.0.113.30") }))
        .status
    ).toBe(429);
    golem.app.artifacts.delete(members.id, alice);
    // A body that is too large is refused before the lookup, so it is not a miss.
    for (let call = 0; call < 20; call += 1) {
      expect((await large("203.0.113.9")).status).toBe(413);
    }
    expect(
      (await golem.call("/a/amber-guess", { headers: from("203.0.113.9") }))
        .status
    ).toBe(404);
  });

  test("the limiter keys an IPv6 client by its /48 network and an IPv4 client by its address", () => {
    expect(clientKey("2001:db8:7:1::1")).toBe("2001:db8:7::/48");
    expect(clientKey("2001:0DB8:0007:ffff:1:2:3:4")).toBe("2001:db8:7::/48");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(clientKey("::1")).toBe("0:0:0::/48");
    expect(clientKey("fe80::1%en0")).toBe("fe80:0:0::/48");
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
  });

  test("assets come from the public folder only", async () => {
    const styles = await golem.call("/assets/styles.css");
    expect(styles.status).toBe(200);
    expect(await styles.text()).toContain("{");
    expect((await golem.call("/assets/missing.css")).status).toBe(404);
    expect((await golem.call("/assets/..%2Fpackage.json")).status).toBe(404);
  });

  test("sign out ends the session", async () => {
    const response = await golem.call("/api/auth/sign-out", {
      body: {},
      headers: { cookie: bobCookie, origin: "http://golem.test" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join()).toContain(
      "better-auth.session_token=;"
    );
    expect(
      (await golem.call("/api/v1/me", { headers: { cookie: bobCookie } }))
        .status
    ).toBe(401);
  });
});

describe("the ChatGPT device login", () => {
  let golem: TestApp;
  let token: string;
  const finish = Promise.withResolvers<OAuthCredential>();

  beforeAll(async () => {
    golem = await startTestApp();
    // The test provider signs in only with a device code, as ChatGPT does.
    const auth = golem.faux.provider.auth as {
      apiKey?: unknown;
      oauth?: unknown;
    };
    auth.apiKey = undefined;
    auth.oauth = {
      name: "Test login",
      login: async (interaction: {
        prompt: (prompt: unknown) => Promise<string>;
        notify: (event: unknown) => void;
      }) => {
        await interaction.prompt({
          type: "select",
          message: "How?",
          options: [{ id: "device_code", label: "Device code" }],
        });
        interaction.notify({ type: "info", message: "Starting" });
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-1234",
          verificationUri: "https://auth.example.com/device",
        });
        return finish.promise;
      },
      refresh: async (credential: OAuthCredential) => credential,
      toAuth: async () => ({}),
    };
    token = await golem.signIn("Alice", "alice@example.com");
  });

  afterAll(() => golem.close());

  test("gives the code until the login finishes, then the models", async () => {
    const status = async () =>
      (await (await golem.call("/api/v1/llm", { token })).json()) as {
        connected: boolean;
        login: { userCode: string; verificationUri: string } | null;
      };
    expect(await status()).toMatchObject({ connected: false, login: null });
    await golem.call("/api/v1/llm/login", { method: "POST", token });
    expect(await status()).toMatchObject({
      connected: false,
      login: {
        userCode: "ABCD-1234",
        verificationUri: "https://auth.example.com/device",
      },
    });

    finish.resolve({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 3_600_000,
    });
    expect(await until(status, (llm) => llm.connected)).toMatchObject({
      login: null,
    });
    await golem.call("/api/v1/llm/logout", { method: "POST", token });
    expect(await status()).toMatchObject({ connected: false });
  });
});

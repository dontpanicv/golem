import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { User } from "../src/platform/auth.ts";
import { cookies, startTestApp, type TestApp, until } from "./harness.ts";

/** A signed-in browser: it sends the session cookie, and form posts carry the site's origin. */
function browser(golem: TestApp, cookie: string) {
  return {
    get: (path: string) => golem.call(path, { headers: { cookie } }),
    post: (path: string, fields: Record<string, string> = {}) =>
      golem.handler(
        new Request(`http://golem.test${path}`, {
          method: "POST",
          headers: { cookie, origin: "http://golem.test" },
          body: new URLSearchParams(fields),
        })
      ),
    /** A Datastar request: signals go in the `datastar` query parameter. Datastar posts forms as `post` does. */
    datastar: (path: string, signals: unknown) =>
      golem.handler(
        new Request(
          `http://golem.test${path}?datastar=${encodeURIComponent(JSON.stringify(signals))}`,
          { headers: { cookie } }
        )
      ),
  };
}
type Browser = ReturnType<typeof browser>;

function location(response: Response): string | null {
  return response.headers.get("location");
}

/** Reads the event stream until `done` is true for the text so far, then closes the stream. */
async function readStream(
  response: Response,
  done: (text: string) => boolean
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!done(text)) {
    const { value, done: ended } = await reader.read();
    if (ended) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

describe("the web app", () => {
  let golem: TestApp;
  let alice: Browser;
  let bob: Browser;
  let workspaceId: string;
  let generalId: string;
  let threadId: string;
  const threadRef = () =>
    golem.app.workspaces
      .threadsIn(workspaceId)
      .find((thread) => thread.id === threadId)!;

  let aliceCookie: string;
  let bobCookie: string;
  const aliceUser = () =>
    golem.app.database
      .query("SELECT id, name, email FROM user WHERE email = ?")
      .get("alice@example.com") as User;

  beforeAll(async () => {
    golem = await startTestApp();
    aliceCookie = await golem.sessionCookie(
      await golem.signIn("Alice", "alice@example.com")
    );
    bobCookie = await golem.sessionCookie(
      await golem.signIn("Bob", "bob@example.com")
    );
    alice = browser(golem, aliceCookie);
    bob = browser(golem, bobCookie);
  });

  afterAll(() => golem.close());

  test("a person who is not signed in goes to the login page", async () => {
    for (const path of ["/workspaces/new", "/settings", "/w/any/c/any"]) {
      const response = await golem.call(path);
      expect(response.status).toBe(303);
      expect(location(response)).toBe("/login");
    }
  });

  test("a person without a workspace creates one, and it opens on its orchestrator thread", async () => {
    expect(location(await alice.get("/"))).toBe("/workspaces/new");
    const page = await (await alice.get("/workspaces/new")).text();
    expect(page).toContain("Create a workspace");
    expect(page).toContain('action="/workspaces"');

    const blank = await alice.post("/workspaces", { name: " " });
    expect(location(blank)).toBe("/workspaces/new?error=Name%20is%20required");
    expect(
      await (
        await alice.get("/workspaces/new?error=Name%20is%20required")
      ).text()
    ).toContain("Name is required");

    const created = await alice.post("/workspaces", { name: "Family" });
    expect(created.status).toBe(303);
    workspaceId = location(created)!.replace("/w/", "");
    const opened = location(await alice.get("/"))!;
    expect(opened).toBe(`/w/${workspaceId}/orchestrator`);
    expect(location(await alice.get(`/w/${workspaceId}`))).toBe(opened);
    const orchestratorPath = location(await alice.get(opened))!;
    expect(orchestratorPath).toStartWith(`/w/${workspaceId}/t/`);
    expect(location(await alice.get(opened))).toBe(orchestratorPath);
    const orchestrator = await (await alice.get(orchestratorPath)).text();
    expect(orchestrator).toContain("<title>Golem · Golem</title>");
    expect(orchestrator).toContain("Message Golem");
    expect(orchestrator).not.toContain("Settle thread");
    expect(orchestrator).toContain(
      `href="/w/${workspaceId}/orchestrator" aria-current="page"`
    );
    generalId = /href="\/w\/[^/]+\/c\/([^"]+)"/.exec(orchestrator)![1]!;
    const channel = await (
      await alice.get(`/w/${workspaceId}/c/${generalId}`)
    ).text();
    expect(channel).toContain("<title>#general · Golem</title>");
    expect(channel).toContain("No threads yet");
    expect(channel).toContain(
      `action="/w/${workspaceId}/c/${generalId}/threads"`
    );
    expect(channel).toContain(`action="/w/${workspaceId}/channels"`);
  });

  test("a new channel opens, and a duplicate name goes back with the error", async () => {
    const created = await alice.post(`/w/${workspaceId}/channels`, {
      name: "Trips",
    });
    const channelPath = location(created)!;
    expect(channelPath).toStartWith(`/w/${workspaceId}/c/`);
    expect(await (await alice.get(channelPath)).text()).toContain(
      "# </span>trips"
    );

    const duplicate = await alice.post(`/w/${workspaceId}/channels`, {
      name: "trips",
    });
    expect(location(duplicate)).toBe(
      `/w/${workspaceId}?error=${encodeURIComponent("#trips already exists")}`
    );
  });

  test("a channel is deleted from its page, and its name is free again", async () => {
    const junk = location(
      await alice.post(`/w/${workspaceId}/channels`, { name: "Junk" })
    )!;
    const page = await (await alice.get(junk)).text();
    expect(page).toContain(`action="${junk}/delete"`);
    expect(page).toContain("Delete #junk?");

    const deleted = await alice.post(`${junk}/delete`);
    expect(location(deleted)).toBe(
      `/w/${workspaceId}/c/${generalId}?notice=${encodeURIComponent("Deleted #junk")}`
    );
    expect((await alice.get(junk)).status).toBe(404);
    expect(
      location(await alice.post(`/w/${workspaceId}/channels`, { name: "junk" }))
    ).not.toBe(junk);
  });

  test("a thread starts from the channel composer and its transcript streams over Datastar", async () => {
    const blank = await alice.post(`/w/${workspaceId}/c/${generalId}/threads`);
    expect(location(blank)).toBe(
      `/w/${workspaceId}/c/${generalId}?error=${encodeURIComponent("Message is required")}`
    );

    golem.faux.setResponses([fauxAssistantMessage("Saturday works.")]);
    const started = await alice.post(
      `/w/${workspaceId}/c/${generalId}/threads`,
      { text: "Plan the cabin trip" }
    );
    const threadPath = location(started)!;
    expect(threadPath).toStartWith(`/w/${workspaceId}/t/`);
    threadId = threadPath.split("/").at(-1)!;

    const channel = await (
      await alice.get(`/w/${workspaceId}/c/${generalId}`)
    ).text();
    expect(channel).toContain(`href="${threadPath}"`);
    expect(channel).not.toContain("No threads yet");

    const page = await (await alice.get(threadPath)).text();
    expect(page).toContain("<title>Plan the cabin trip · Golem</title>");
    expect(page).toContain("general › </span>Plan the cabin trip");
    expect(page).toContain(`@get(&#x27;${threadPath}/events&#x27;)`);
    expect(page).toContain('aria-label="Artifacts"');

    await until(
      () => golem.app.threads.messages(threadRef()),
      (state) => state.messages.length === 2 && !state.running
    );
    const events = await alice.get(`${threadPath}/events`);
    expect(events.headers.get("content-type")).toStartWith("text/event-stream");
    const text = await readStream(events, (sofar) =>
      sofar.includes("</section>")
    );
    expect(text).toContain("event: datastar-patch-elements");
    expect(text).toContain('id="transcript"');
    expect(text).toContain("Plan the cabin trip");
    expect(text).toContain("Saturday works.");
  });

  test("a settled thread leaves the active list and can return", async () => {
    const workspace = await golem.app.workspaces.create(
      aliceUser(),
      "Settle test"
    );
    const channel = golem.app.workspaces.channels(
      workspace.id,
      aliceUser()
    )[0]!;
    const thread = await golem.app.threads.create(
      workspace.id,
      aliceUser(),
      channel.id,
      "Keep this thread"
    );
    const channelPath = `/w/${workspace.id}/c/${channel.id}`;
    const threadPath = `/w/${workspace.id}/t/${thread.id}`;
    const action = `${threadPath}/settled`;
    expect((await bob.post(action, { settled: "true" })).status).toBe(404);
    expect(location(await alice.post(action, { settled: "true" }))).toBe(
      channelPath
    );
    expect(
      golem.app.workspaces.thread(thread.id, aliceUser()).settledAt
    ).toBeNumber();
    const settled = await (await alice.get(channelPath)).text();
    expect(settled).toContain("Settled (1)");
    expect(settled).toContain(
      '<details id="sidebar-settled" class="sidebar-settled" data-preserve-attr="open">'
    );
    expect(settled.indexOf('class="sidebar-settled"')).toBeLessThan(
      settled.indexOf('class="nav sidebar-footer"')
    );
    expect(settled).toContain(`href="${threadPath}"`);
    expect(settled).toContain('value="false"');
    expect((await alice.get(threadPath)).status).toBe(200);
    expect(location(await alice.post(action, { settled: "false" }))).toBe(
      channelPath
    );
    expect(
      golem.app.workspaces.thread(thread.id, aliceUser()).settledAt
    ).toBeNull();
    expect(await (await alice.get(channelPath)).text()).not.toContain(
      "Settled (1)"
    );
  });

  test("a message posts over Datastar, clears the composer, and joins the thread", async () => {
    const path = `/w/${workspaceId}/t/${threadId}/messages`;
    expect((await alice.post(path, { text: "  " })).status).toBe(400);
    expect((await alice.post(path)).status).toBe(400);

    golem.faux.setResponses([fauxAssistantMessage("Bring boots.")]);
    const sent = await alice.post(path, { text: "What to pack?" });
    expect(await sent.text()).toContain(
      "document.getElementById('composer').reset()"
    );
    const state = await until(
      () => golem.app.threads.messages(threadRef()),
      (current) => current.messages.length === 4 && !current.running
    );
    expect(state.messages.map((message) => message.text)).toEqual([
      "Plan the cabin trip",
      "Saturday works.",
      "What to pack?",
      "Bring boots.",
    ]);
  });

  test("an artifact link runs the artifact in a sandbox, for anyone when public and for members otherwise", async () => {
    const artifact = golem.app.artifacts.create(threadRef(), generalId, {
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
    expect(await content.text()).toContain("window.golem = golem");

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

    golem.app.artifacts.setVisibility(artifact.id, aliceUser(), "members");
    const signedOut = await golem.call(link);
    expect(location(signedOut)).toBe(`/login?next=${link}`);
    expect(await (await golem.call(`/login?next=${link}`)).text()).toContain(
      `<input type="hidden" name="next" value="${link}">`
    );
    expect((await golem.call(`${link}/content`)).status).toBe(404);
    expect((await bob.get(link)).status).toBe(404);
    expect((await bob.get(`${link}/content`)).status).toBe(404);
    expect((await alice.get(link)).status).toBe(200);
  });

  test("the public host serves only public artifacts at /<name>, and nothing else", async () => {
    const thread = threadRef();
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

    for (const path of [
      `/${closed.id}`,
      `/${closed.id}/content`,
      `/a/${open.id}`,
      "/",
      "/login",
      "/api/v1/me",
      `/w/${workspaceId}`,
      "/assets/styles.css",
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
    golem.app.artifacts.delete(open.id, aliceUser());
    golem.app.artifacts.delete(closed.id, aliceUser());
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
      aliceUser()
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
  });

  test("the Artifacts list of a thread and its channel opens a preview that returns to the list", async () => {
    const [artifact] = golem.app.artifacts.inPlace(
      workspaceId,
      generalId,
      aliceUser()
    );
    const base = `/w/${workspaceId}/artifacts/${artifact!.id}`;
    golem.app.artifacts.call(artifact!.id, { user: aliceUser() }, "set", {
      scope: "mine",
      key: "vote",
      value: "15 Dec",
    });
    const page = await (
      await alice.get(`/w/${workspaceId}/t/${threadId}`)
    ).text();
    expect(page).toContain('id="artifact-list"');
    expect(page).toContain('role="tablist" data-show="$tab !== \'preview\'"');
    expect(page).toContain("data-on:click=\"$tab = 'artifacts'\"");
    expect(page).not.toContain(
      'role="tab" class="tab" data-attr:aria-selected="$tab === \'preview\''
    );
    expect(page).toContain(`@get('${base}')`);
    expect(page).toContain("Trip &lt;dates&gt;");

    const preview = await (await alice.datastar(base, {})).text();
    expect(preview).toContain(
      `<iframe class="artifact-frame" src="/a/${artifact!.id}?v=`
    );
    expect(preview).toContain("Alice · &quot;15 Dec&quot;");
    expect(preview).toContain('"tab":"preview"');

    const visibility = await readStream(
      await alice.post(`${base}/visibility/public`),
      (text) => text.includes("artifact-preview")
    );
    expect(visibility).toContain("Make members only");
    const datastar = (method: string, path: string, who = aliceCookie) =>
      golem.handler(
        new Request(`http://golem.test${path}`, {
          method,
          headers: { cookie: who, origin: "http://golem.test" },
        })
      );
    const [record] = golem.app.artifacts.dataFor(artifact!.id, aliceUser());
    expect(
      (await datastar("DELETE", `${base}/records/${record!.id}`, bobCookie))
        .status
    ).toBe(404);
    await (await datastar("DELETE", `${base}/records/${record!.id}`)).text();
    expect(golem.app.artifacts.dataFor(artifact!.id, aliceUser())).toEqual([]);
    const deleted = await (await datastar("DELETE", base)).text();
    expect(deleted).toContain("No artifacts yet");
    expect(deleted).toContain('"tab":"artifacts"');
  });

  test("pages outside the workspace are not found", async () => {
    const other = location(
      await alice.post("/workspaces", { name: "Work" })
    )!.replace("/w/", "");
    // An empty workspace opens on its settings, because it has no channel to show.
    golem.app.database
      .query("DELETE FROM channel WHERE workspace_id = ?")
      .run(other);
    expect(location(await alice.get(`/w/${other}`))).toBe(
      `/w/${other}/settings`
    );

    const notFound = [
      alice.get(`/w/${other}/t/${threadId}`),
      alice.get(`/w/${workspaceId}/c/unknown`),
      alice.get("/w/unknown/search"),
      bob.get(`/w/${workspaceId}/t/${threadId}`),
      bob.get(`/w/${workspaceId}/settings`),
    ];
    for (const response of await Promise.all(notFound)) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });

  test("search finds the thread on the page and as you type", async () => {
    await golem.app.indexer.scan(workspaceId);
    const empty = await (await alice.get(`/w/${workspaceId}/search`)).text();
    expect(empty).toContain('<div id="results" class="search-results"></div>');

    const page = await (
      await alice.get(`/w/${workspaceId}/search?q=cabin`)
    ).text();
    expect(page).toContain('value="cabin"');
    expect(page).toContain(`href="/w/${workspaceId}/t/${threadId}"`);
    expect(page).toContain("#general");

    const live = await (
      await alice.datastar(`/w/${workspaceId}/search/results`, { q: "cabin" })
    ).text();
    expect(live).toContain("event: datastar-patch-elements");
    expect(live).toContain('id="results"');
    expect(live).toContain(`href="/w/${workspaceId}/t/${threadId}"`);

    const nothing = await (
      await alice.datastar(`/w/${workspaceId}/search/results`, {
        q: "zebra",
      })
    ).text();
    expect(nothing).toContain("Nothing found");
    const noQuery = await (
      await alice.datastar(`/w/${workspaceId}/search/results`, {})
    ).text();
    expect(noQuery).toContain(
      '<div id="results" class="search-results"></div>'
    );
  });

  test("search opens an artifact in its channel or the orchestrator, and a file itself", async () => {
    const thread = golem.app.workspaces.thread(threadId, aliceUser());
    const recipe = golem.app.artifacts.create(thread, generalId, {
      title: "Banana bread",
      html: "<p>Bananas, flour, and cardamom</p>",
      requestKey: crypto.randomUUID(),
    });
    const [contract] = await golem.app.threads.upload(
      workspaceId,
      generalId,
      aliceUser(),
      [new File(["The notice period is three months"], "contract.txt")]
    );
    await golem.app.indexer.scan(workspaceId);

    const opened = `/w/${workspaceId}/c/${generalId}?artifact=${recipe.id}`;
    const artifactResults = await (
      await alice.get(`/w/${workspaceId}/search?q=cardamom`)
    ).text();
    expect(artifactResults).toContain(`href="${opened}"`);
    const channel = await (await alice.get(opened)).text();
    expect(channel).toContain(
      `<iframe class="artifact-frame" src="/a/${recipe.id}?v=`
    );
    expect(channel).toContain("tab: &#x27;preview&#x27;");

    const fileResults = await (
      await alice.get(`/w/${workspaceId}/search?q=notice+period`)
    ).text();
    const href = `/w/${workspaceId}/files/${contract!.id}`;
    expect(fileResults).toContain(`href="${href}" target="_blank"`);
    expect(await (await alice.get(href)).text()).toBe(
      "The notice period is three months"
    );
    golem.app.artifacts.delete(recipe.id, aliceUser());

    // The workspace's own artifact opens in the orchestrator, and its files list there.
    const chores = golem.app.artifacts.create(thread, null, {
      title: "Chores",
      html: "<p>Dishes and laundry rota</p>",
      requestKey: crypto.randomUUID(),
    });
    await golem.app.threads.upload(workspaceId, null, aliceUser(), [
      new File(["Rent 900"], "budget.txt"),
    ]);
    await golem.app.indexer.scan(workspaceId);
    const workspaceResults = await (
      await alice.get(`/w/${workspaceId}/search?q=laundry`)
    ).text();
    const orchestrator = `/w/${workspaceId}/orchestrator?artifact=${chores.id}`;
    expect(workspaceResults).toContain(`href="${orchestrator}"`);
    const redirected = location(await alice.get(orchestrator))!;
    expect(redirected).toEndWith(`?artifact=${chores.id}`);
    const home = await (await alice.get(redirected)).text();
    expect(home).toContain(`src="/a/${chores.id}?v=`);
    expect(home).toContain("budget.txt");
    expect(home).toContain(`@post('/w/${workspaceId}/files'`);
    golem.app.artifacts.delete(chores.id, aliceUser());
  });

  test("workspace settings add members and keep credential secrets on the server", async () => {
    const settings = `/w/${workspaceId}/settings`;
    const page = await (await alice.get(settings)).text();
    expect(page).toContain("alice@example.com");
    expect(page).toContain("No credentials · Personal access token");
    expect(page).toContain(`action="/w/${workspaceId}/machines/pairing"`);
    // The test server is not on https, so machines cannot pair with it.
    expect(
      location(await alice.post(`/w/${workspaceId}/machines/pairing`))
    ).toStartWith(`${settings}?error=Machines%20pair%20over%20HTTPS`);

    const unknown = await alice.post(`/w/${workspaceId}/members`, {
      email: "nobody@example.com",
    });
    expect(location(unknown)).toBe(
      `${settings}?error=${encodeURIComponent("Nobody has signed up with that email yet")}`
    );
    const added = await alice.post(`/w/${workspaceId}/members`, {
      email: "bob@example.com",
    });
    expect(location(added)).toBe(
      `${settings}?notice=${encodeURIComponent("Bob joined the workspace")}`
    );
    expect(await (await alice.get(location(added)!)).text()).toContain(
      "Bob joined the workspace"
    );
    expect((await bob.get(settings)).status).toBe(200);

    const github = () =>
      golem.app.integrations
        .list(workspaceId, aliceUser())
        .find((integration) => integration.id === "github")!;
    expect(
      (
        await alice.post(`/w/${workspaceId}/integrations/unknown/credentials`, {
          label: "Key",
          secret: "x",
        })
      ).status
    ).toBe(404);

    const credential = await alice.post(
      `/w/${workspaceId}/integrations/github/credentials`,
      { label: "Family", secret: "family-secret" }
    );
    expect(location(credential)).toBe(
      `${settings}?notice=${encodeURIComponent("Credential added")}`
    );
    const [added_] = github().credentials;
    expect(added_).toMatchObject({ label: "Family", ownerName: "Alice" });
    const withCredential = await (await alice.get(settings)).text();
    expect(withCredential).toContain("1 credential · Personal access token");
    expect(withCredential).toContain("Delete Family");
    expect(withCredential).not.toContain("family-secret");
    // Credentials belong to the workspace: Bob sees it and may delete it.
    const bobsView = await (await bob.get(settings)).text();
    expect(bobsView).toContain("Added by Alice");
    expect(bobsView).toContain("Delete Family");

    const missingLabel = await alice.post(
      `/w/${workspaceId}/integrations/github/credentials`,
      { secret: "x" }
    );
    expect(location(missingLabel)).toBe(
      `${settings}?error=${encodeURIComponent("Label is required")}`
    );

    const deleted = await alice.post(
      `/w/${workspaceId}/credentials/${added_!.id}/delete`
    );
    expect(location(deleted)).toBe(
      `${settings}?notice=${encodeURIComponent("Credential deleted")}`
    );
    expect(github().credentials).toEqual([]);
  });

  test("the channel details page shows the summary and routines, and pauses, runs, and deletes them", async () => {
    const details = `/w/${workspaceId}/c/${generalId}/details`;
    const channel = await (
      await alice.get(`/w/${workspaceId}/c/${generalId}`)
    ).text();
    expect(channel).toContain(`href="${details}"`);
    expect(await (await alice.get(details)).text()).toContain(
      "No routines yet"
    );

    golem.app.workspaces.setChannelSummary(
      workspaceId,
      generalId,
      "Family plans."
    );
    const routine = golem.app.routines.create(workspaceId, generalId, {
      id: crypto.randomUUID(),
      name: "Morning",
      schedule: "0 7 * * *",
      instructions: "Say what is new.",
      script: "return [];",
      createdBy: "golem",
    });
    const page = await (await alice.get(details)).text();
    expect(page).toContain("Family plans.");
    expect(page).toContain("Morning");
    expect(page).toContain("Next ");
    expect(page).toContain("No runs yet");

    const base = `/w/${workspaceId}/c/${generalId}/routines/${routine.id}`;
    expect(location(await alice.post(base))).toBe(details);
    expect(await (await alice.get(details)).text()).toContain("Paused");
    await alice.post(base, { enabled: "true" });
    expect(golem.app.routines.get(routine.id, aliceUser()).enabled).toBe(true);

    expect(location(await alice.post(`${base}/run`))).toBe(
      `${details}?notice=${encodeURIComponent("Morning runs now")}`
    );
    const ran = await until(
      async () => (await alice.get(details)).text(),
      (text) => text.includes("Quiet")
    );
    expect(ran).not.toContain("No runs yet");

    expect(location(await alice.post(`${base}/delete`))).toBe(
      `${details}?notice=${encodeURIComponent("Morning deleted")}`
    );
    expect(await (await alice.get(details)).text()).toContain(
      "No routines yet"
    );
    expect((await alice.post(`${base}/run`)).status).toBe(404);
  });

  test("settings show the account and change the model and effort", async () => {
    const page = await (await alice.get("/settings")).text();
    expect(page).toContain("<title>Settings · Golem</title>");
    expect(page).toContain("alice@example.com");
    expect(page).toContain('action="/logout"');
    expect(page).toContain("Connected");
    expect(page).toContain('action="/settings/llm/model"');
    expect(page).toContain(`data-value="${golem.model.id}"`);
    // The sidebar keeps the first workspace.
    expect(page).toContain(`href="/w/${workspaceId}/settings"`);

    const card = await (await alice.get("/settings/llm")).text();
    expect(card).toContain("event: datastar-patch-elements");
    expect(card).toContain('<div id="llm">');

    expect(
      location(
        await alice.post("/settings/llm/model", { model: golem.model.id })
      )
    ).toBe("/settings");
    expect(golem.app.llm.model()).toBe(golem.model.id);
    expect(
      location(await alice.post("/settings/llm/model", { model: "nope" }))
    ).toBe(`/settings?error=${encodeURIComponent("Unknown model: nope")}`);
    expect(
      location(await alice.post("/settings/llm/effort", { effort: "off" }))
    ).toBe("/settings");
    expect(
      location(await alice.post("/settings/llm/effort", { effort: "high" }))
    ).toBe(`/settings?error=${encodeURIComponent("Unknown effort: high")}`);
  });

  test("a provider without device login shows why the login failed", async () => {
    expect(location(await alice.post("/settings/llm/login"))).toBe("/settings");
    const page = await (await alice.get("/settings")).text();
    expect(page).toContain("does not support oauth login");
    expect(location(await alice.post("/settings/llm/logout"))).toBe(
      "/settings"
    );
    expect(await (await alice.get("/settings")).text()).not.toContain(
      "does not support oauth login"
    );
  });

  test("assets come from the public folder only", async () => {
    const styles = await golem.call("/assets/styles.css");
    expect(styles.status).toBe(200);
    expect(await styles.text()).toContain("{");
    expect((await golem.call("/assets/missing.css")).status).toBe(404);
  });

  test("sign out ends the session", async () => {
    const response = await bob.post("/logout");
    expect(location(response)).toBe("/login");
    expect(response.headers.getSetCookie().join()).toContain(
      "better-auth.session_token=;"
    );
    expect(location(await bob.get("/"))).toBe("/login");
  });
});

describe("the ChatGPT device login", () => {
  let golem: TestApp;
  let alice: Browser;
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
    alice = browser(
      golem,
      await golem.sessionCookie(
        await golem.signIn("Alice", "alice@example.com")
      )
    );
  });

  afterAll(() => golem.close());

  test("shows the code until the login finishes, then the model choices", async () => {
    const before = await (await alice.get("/settings")).text();
    expect(before).toContain('action="/settings/llm/login"');
    expect(before).not.toContain('action="/settings/llm/model"');

    expect(location(await alice.post("/settings/llm/login"))).toBe("/settings");
    const waiting = await (await alice.get("/settings")).text();
    expect(waiting).toContain("Waiting");
    expect(waiting).toContain("Enter this code at auth.example.com");
    expect(waiting).toContain('data-copy="ABCD-1234"');
    expect(waiting).toContain('href="https://auth.example.com/device"');
    expect(waiting).toContain(
      "data-on-interval__duration.2s=\"@get('/settings/llm')\""
    );

    finish.resolve({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 3_600_000,
    });
    const connected = await until(
      async () => (await alice.get("/settings/llm")).text(),
      (card) => card.includes("Connected")
    );
    expect(connected).not.toContain("ABCD-1234");
    expect(connected).not.toContain("data-on-interval");
    expect(connected).toContain('action="/settings/llm/model"');
    expect(connected).toContain('action="/settings/llm/logout"');

    await alice.post("/settings/llm/logout");
    expect(await (await alice.get("/settings")).text()).toContain(
      'action="/settings/llm/login"'
    );
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, type TestApp, until } from "./harness.ts";

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
    /** A Datastar request: signals go in the `datastar` query parameter for GET, and in a JSON body for POST. */
    datastar: (path: string, signals: unknown, method = "GET") =>
      golem.handler(
        method === "GET"
          ? new Request(
              `http://golem.test${path}?datastar=${encodeURIComponent(JSON.stringify(signals))}`,
              { headers: { cookie } }
            )
          : new Request(`http://golem.test${path}`, {
              method,
              headers: { cookie, "content-type": "application/json" },
              body: JSON.stringify(signals),
            })
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

  beforeAll(async () => {
    golem = await startTestApp();
    alice = browser(
      golem,
      await golem.sessionCookie(
        await golem.signIn("Alice", "alice@example.com")
      )
    );
    bob = browser(
      golem,
      await golem.sessionCookie(await golem.signIn("Bob", "bob@example.com"))
    );
  });

  afterAll(() => golem.close());

  test("a person who is not signed in goes to the login page", async () => {
    for (const path of ["/workspaces/new", "/settings", "/w/any/c/any"]) {
      const response = await golem.call(path);
      expect(response.status).toBe(303);
      expect(location(response)).toBe("/login");
    }
  });

  test("a person without a workspace creates one, and it opens on #general", async () => {
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
    expect(location(await alice.get("/"))).toBe(`/w/${workspaceId}`);

    const opened = location(await alice.get(`/w/${workspaceId}`))!;
    expect(opened).toStartWith(`/w/${workspaceId}/c/`);
    generalId = opened.split("/").at(-1)!;
    const channel = await (await alice.get(opened)).text();
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

  test("a message posts over Datastar, clears the composer, and joins the thread", async () => {
    const path = `/w/${workspaceId}/t/${threadId}/messages`;
    expect((await alice.datastar(path, { message: "  " }, "POST")).status).toBe(
      400
    );
    expect((await alice.datastar(path, {}, "POST")).status).toBe(400);

    golem.faux.setResponses([fauxAssistantMessage("Bring boots.")]);
    const sent = await alice.datastar(
      path,
      { message: "What to pack?" },
      "POST"
    );
    expect(await sent.text()).toContain(
      'event: datastar-patch-signals\ndata: signals {"message":""}'
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

  test("workspace settings add members and keep credential secrets on the server", async () => {
    const settings = `/w/${workspaceId}/settings`;
    const page = await (await alice.get(settings)).text();
    expect(page).toContain("alice@example.com");
    expect(page).toContain("No credentials · Personal access token");
    expect(page).toContain('aria-label="Use GitHub"');
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

    const enabled = await alice.post(`/w/${workspaceId}/integrations/github`, {
      enabled: "true",
    });
    expect(location(enabled)).toBe(settings);
    const github = () =>
      golem.app.integrations
        .list(workspaceId, aliceUser())
        .find((integration) => integration.id === "github")!;
    expect(github().enabled).toBe(true);
    await alice.post(`/w/${workspaceId}/integrations/github`);
    expect(github().enabled).toBe(false);
    expect(
      (await alice.post(`/w/${workspaceId}/integrations/unknown`)).status
    ).toBe(404);

    const credential = await alice.post(
      `/w/${workspaceId}/integrations/github/credentials`,
      { label: "Family", secret: "family-secret", shared: "true" }
    );
    expect(location(credential)).toBe(
      `${settings}?notice=${encodeURIComponent("Credential added")}`
    );
    const [added_] = github().credentials;
    expect(added_).toMatchObject({ label: "Family", shared: true, mine: true });
    const withCredential = await (await alice.get(settings)).text();
    expect(withCredential).toContain("1 credential · Personal access token");
    expect(withCredential).toContain("Shared with workspace");
    expect(withCredential).toContain("Delete Family");
    expect(withCredential).not.toContain("family-secret");
    // Bob sees the shared credential, but only its owner may delete it.
    const bobsView = await (await bob.get(settings)).text();
    expect(bobsView).toContain("Added by Alice");
    expect(bobsView).not.toContain("Delete Family");

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

    function aliceUser() {
      return golem.app.database
        .query("SELECT id, name, email FROM user WHERE email = ?")
        .get("alice@example.com") as never;
    }
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

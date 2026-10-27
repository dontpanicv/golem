import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, exists } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { startTestApp, type TestApp } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";
import { Secrets } from "../platform/secrets.ts";
import { type Connector, Integrations } from "./integrations.ts";
import { whatsAppConnector } from "./whatsapp.ts";

let golem: TestApp;
let alice: User;
/** A person who is not the server's owner. */
const notOwner: User = { id: "otto", name: "Otto", email: "otto@example.com" };
let workspaceId: string;
/** A sign-in server and an MCP server's address, as Rohlík's are, on a local port. */
let signInServer: ReturnType<typeof Bun.serve>;
/** What the sign-in server's token endpoint got. */
const tokenRequests: URLSearchParams[] = [];
/** The access token that each MCP connection had. */
const connectedWith: (string | undefined)[] = [];
const changes: string[] = [];
let integrations: Integrations;

beforeAll(async () => {
  golem = await startTestApp();
  await golem.signIn("Alice", "alice@example.com");
  const { internalAdapter } = await golem.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(
    "alice@example.com"
  ))!;
  alice = { id: user.id, name: user.name, email: user.email };
  workspaceId = (await golem.app.workspaces.create(alice, "Family")).id;
  signInServer = Bun.serve({ port: 0, fetch: signIn });
  const shop: Connector = {
    id: "shop",
    name: "Shop",
    description: "Groceries.",
    secretLabel: null,
    tools: [],
    mcp: [new URL("/mcp", signInServer.url).href],
  };
  integrations = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    {
      directory: join(golem.app.config.dataDirectory, "integrations"),
      catalog: [shop],
      changed: (id) => changes.push(id),
      transport: (_url, provider) => {
        const [client, server] = InMemoryTransport.createLinkedPair();
        connectedWith.push(
          (provider.tokens() as { access_token: string } | undefined)
            ?.access_token
        );
        shopServer().connect(server);
        return client;
      },
    }
  );
});
afterAll(async () => {
  await integrations.close();
  signInServer.stop();
  await golem.close();
});

/** The OAuth metadata, client registration, and tokens of a sign-in server. */
async function signIn(request: Request): Promise<Response> {
  const { origin, pathname } = new URL(request.url);
  if (pathname === "/.well-known/oauth-protected-resource/mcp") {
    return Response.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });
  }
  if (pathname === "/.well-known/oauth-authorization-server") {
    return Response.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (pathname === "/register") {
    return Response.json(
      { ...((await request.json()) as object), client_id: "golem-client" },
      { status: 201 }
    );
  }
  if (pathname === "/token") {
    const parameters = new URLSearchParams(await request.text());
    tokenRequests.push(parameters);
    // Golem's own client signs in to Google, whose token names the account.
    const owned =
      parameters.has("client_secret") || request.headers.has("authorization");
    if (parameters.get("grant_type") === "refresh_token") {
      return Response.json({
        access_token: "access-refreshed",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return Response.json({
      access_token:
        parameters.get("code") === "code-own" ? "access-own" : "access-1",
      token_type: "Bearer",
      refresh_token: "refresh-1",
      ...(owned
        ? {
            id_token: `x.${btoa(JSON.stringify({ email: "anna@work.example" }))}.x`,
          }
        : {}),
    });
  }
  return new Response("Not found", { status: 404 });
}

/** An MCP server with a tool that returns a value, one that returns text, and one that fails. */
function shopServer(): Server {
  const server = new Server(
    { name: "shop", version: "1" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_products",
        description: "Find products by name",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        outputSchema: {
          type: "object",
          properties: { products: { type: "array" } },
        },
      },
      {
        name: "cart",
        description: "The cart",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "checkout",
        description: "Pay",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === "search_products") {
      const products = [{ name: `${params.arguments?.query} 1 l` }];
      return {
        content: [{ type: "text", text: JSON.stringify({ products }) }],
        structuredContent: { products },
      };
    }
    if (params.name === "cart") {
      return { content: [{ type: "text", text: "The cart is empty." }] };
    }
    return {
      content: [{ type: "text", text: "Paying is not possible." }],
      isError: true,
    };
  });
  return server;
}

test("people connect an MCP server by signing in, and agents get its tools", async () => {
  expect(await integrations.tools(workspaceId)).toEqual([]);
  expect(() =>
    integrations.addCredential(workspaceId, alice, "shop", {
      label: "Shop",
      secret: "x",
    })
  ).toThrow("Connect it by signing in");

  const { url } = (await integrations.connect(workspaceId, alice, "shop")) as {
    url: string;
  };
  const page = new URL(url);
  expect(page.pathname).toBe("/authorize");
  expect(page.searchParams.get("client_id")).toBe("golem-client");
  expect(page.searchParams.get("redirect_uri")).toBe(
    "https://localhost/golem-sign-in"
  );
  expect(page.searchParams.get("resource")).toBe(`${page.origin}/mcp`);
  expect(page.searchParams.get("code_challenge_method")).toBe("S256");
  const state = page.searchParams.get("state")!;
  // The sign-in page ends at the loopback address, which the person pastes.
  const address = `https://localhost/golem-sign-in?code=code-1&state=${state}`;

  await expect(
    integrations.finishConnect(workspaceId, alice, "shop", "https://localhost/")
  ).rejects.toThrow("This is not the address of your sign-in");
  expect(
    await integrations.finishConnect(workspaceId, alice, "shop", address)
  ).toMatchObject({ label: "Shop", ownerName: "Alice" });
  expect(tokenRequests.at(-1)?.get("code")).toBe("code-1");
  expect(tokenRequests.at(-1)?.get("code_verifier")).toBeTruthy();
  expect(changes).toContain(workspaceId);
  await expect(
    integrations.finishConnect(workspaceId, alice, "shop", address)
  ).rejects.toThrow("This is not the address of your sign-in");
  const [shop] = integrations.list(workspaceId, alice);
  expect(shop).toMatchObject({ connect: "sign-in", secretLabel: null });
  expect(shop!.credentials).toMatchObject([
    { label: "Shop", ownerName: "Alice" },
  ]);

  const tools = await integrations.tools(workspaceId);
  expect(tools.map((tool) => tool.name)).toEqual([
    "shop_search_products",
    "shop_cart",
    "shop_checkout",
    "shop_accounts",
  ]);
  expect(connectedWith.at(-1)).toBe("access-1");
  const [search, cart, checkout] = tools;
  expect(search!.outputSchema).toBeDefined();
  const turn = { userId: alice.id };
  expect(await search!.execute({ query: "milk" }, turn)).toEqual({
    products: [{ name: "milk 1 l" }],
  });
  expect(await cart!.execute({}, turn)).toBe("The cart is empty.");
  await expect(checkout!.execute({}, turn)).rejects.toThrow(
    "Paying is not possible."
  );
  expect(integrations.namespaces()).toEqual([
    { name: "shop", prefix: "shop_", description: "Groceries." },
  ]);

  integrations.deleteCredential(workspaceId, alice, shop!.credentials[0]!.id);
  expect(await integrations.tools(workspaceId)).toEqual([]);
});

test("the workspace's sign-in lists an MCP server's tools, also when a member signed in on their own", async () => {
  const signInTo = async (place: string | null, code: string) => {
    const { url } = (await integrations.connect(place, alice, "shop")) as {
      url: string;
    };
    const state = new URL(url).searchParams.get("state")!;
    return integrations.finishConnect(
      place,
      alice,
      "shop",
      `https://localhost/golem-sign-in?code=${code}&state=${state}`
    );
  };
  const shared = await signInTo(workspaceId, "code-1");
  const own = await signInTo(null, "code-own");
  await integrations.tools(workspaceId);
  expect(connectedWith.at(-1)).toBe("access-1");
  integrations.deleteCredential(workspaceId, alice, shared.id);
  await integrations.tools(workspaceId);
  expect(connectedWith.at(-1)).toBe("access-own");
  integrations.deleteCredential(null, alice, own.id);
});

test("a sign-in that did not finish adds nothing", async () => {
  const { url } = (await integrations.connect(workspaceId, alice, "shop")) as {
    url: string;
  };
  const state = new URL(url).searchParams.get("state")!;
  await expect(
    integrations.finishConnect(
      workspaceId,
      alice,
      "shop",
      `https://localhost/golem-sign-in?error=access_denied&state=${state}`
    )
  ).rejects.toThrow("The sign-in did not finish");
  expect(integrations.list(workspaceId, alice)[0]!.credentials).toEqual([]);
});

test("a turn uses its person's own credential, else the workspace's, in each of their workspaces", async () => {
  await golem.signIn("Bob", "bob@example.com");
  const { internalAdapter } = await golem.app.auth.$context;
  const found = (await internalAdapter.findUserByEmail("bob@example.com"))!;
  const bob = {
    id: found.user.id,
    name: found.user.name,
    email: found.user.email,
  };
  await golem.app.workspaces.addMember(workspaceId, alice, bob.email);
  const work = (await golem.app.workspaces.create(alice, "Work")).id;
  const reached: string[] = [];
  const notes = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    {
      directory: join(golem.app.config.dataDirectory, "integrations"),
      catalog: [
        {
          id: "notes",
          name: "Notes",
          description: "Notes.",
          secretLabel: "Token",
          tools: [
            {
              name: "notes_token",
              description: "The token a call uses",
              parameters: Type.Object({}),
              execute: async (_args, secret) => secret,
            },
          ],
        },
      ],
      changed: (id) => reached.push(id),
    }
  );
  const token = async (place: string, userId: string | null) => {
    const [tool] = await notes.tools(place);
    return tool!.execute({}, { userId });
  };
  notes.addCredential(workspaceId, bob, "notes", {
    label: "Family",
    secret: "family",
  });
  const own = notes.addCredential(null, alice, "notes", {
    label: "Mine",
    secret: "alice",
  });
  expect(reached).toEqual([workspaceId, workspaceId, work]);

  expect(await token(workspaceId, alice.id)).toBe("alice");
  expect(await token(workspaceId, bob.id)).toBe("family");
  expect(await token(workspaceId, null)).toBe("family");
  expect(await token(work, alice.id)).toBe("alice");
  // Bob is not a member of Work, and Work has no credential of its own.
  await expect(token(work, bob.id)).rejects.toThrow("Notes is not connected");

  expect(notes.list(null, alice)[0]!.credentials).toMatchObject([
    { label: "Mine" },
  ]);
  expect(notes.list(null, bob)[0]!.credentials).toEqual([]);
  expect(notes.list(workspaceId, bob)[0]!.credentials).toMatchObject([
    { label: "Family" },
  ]);
  expect(() => notes.deleteCredential(null, bob, own.id)).toThrow("Not found");
  expect(() => notes.deleteCredential(workspaceId, alice, own.id)).toThrow(
    "Not found"
  );
  notes.deleteCredential(null, alice, own.id);
  expect(await token(workspaceId, alice.id)).toBe("family");
});

test("a secret of a connector with an address keeps its server's address", async () => {
  const home = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    {
      directory: join(golem.app.config.dataDirectory, "integrations"),
      catalog: [
        {
          id: "home",
          name: "Home",
          description: "The home.",
          secretLabel: "Token",
          address: true,
          tools: [
            {
              name: "home_secret",
              description: "The secret a call gets",
              parameters: Type.Object({}),
              execute: async (_args, secret) => JSON.parse(secret),
            },
          ],
        },
      ],
    }
  );
  const add = (address?: string) =>
    home.addCredential(workspaceId, alice, "home", {
      label: "Home",
      secret: "token",
      ...(address === undefined ? {} : { address }),
    });
  expect(() => add()).toThrow("Address is required");
  expect(() => add("file:///etc")).toThrow("http:// or https://");
  add("http://home.local:8123");
  expect(home.list(workspaceId, alice)[0]!.address).toBe(true);
  const [tool] = await home.tools(workspaceId);
  expect(await tool!.execute({}, { userId: alice.id })).toEqual({
    address: "http://home.local:8123/",
    secret: "token",
  });
});

test("only the server's owner sets Golem's own client, and its MCP server hides the tools that send", async () => {
  const chat: Connector = {
    id: "chat",
    name: "Chat",
    description: "Messages.",
    secretLabel: null,
    tools: [],
    mcp: [new URL("/mcp", signInServer.url).href],
    registered: true,
    scope: "search chat:write",
    hiddenTools: ["checkout"],
  };
  const { database, workspaces } = golem.app;
  const withOwner = new Integrations(database, Secrets.forTests(), workspaces, {
    directory: join(golem.app.config.dataDirectory, "integrations"),
    catalog: [chat],
    owner: "Alice@example.com",
    transport: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      shopServer().connect(serverSide);
      return clientSide;
    },
  });
  // Until the owner sets the client, only the owner sees the integration, and nobody can connect it.
  expect(withOwner.list(null, notOwner)).toEqual([]);
  expect(withOwner.list(null, alice)[0]!.client).toEqual({
    clientId: null,
    changeable: true,
  });
  await expect(withOwner.connect(null, alice, "chat")).rejects.toThrow(
    "The server's owner has not set the client of Chat"
  );
  expect(() =>
    withOwner.setClient(notOwner, "chat", { clientId: "x", clientSecret: "y" })
  ).toThrow("Only the server's owner sets the client");
  withOwner.setClient(alice, "chat", {
    clientId: " own-client ",
    clientSecret: "shh",
  });
  expect(withOwner.list(null, notOwner)[0]!.client).toEqual({
    clientId: "own-client",
    changeable: false,
  });

  const { url } = (await withOwner.connect(null, alice, "chat")) as {
    url: string;
  };
  const page = new URL(url);
  expect(page.searchParams.get("client_id")).toBe("own-client");
  expect(page.searchParams.get("scope")).toBe("search chat:write");
  const credential = await withOwner.finishConnect(
    null,
    alice,
    "chat",
    `https://localhost/golem-sign-in?code=code-2&state=${page.searchParams.get("state")}`
  );
  expect(credential.label).toBe("anna@work.example");
  expect((await withOwner.tools(workspaceId)).map((tool) => tool.name)).toEqual(
    ["chat_search_products", "chat_cart", "chat_accounts"]
  );
  withOwner.deleteCredential(null, alice, credential.id);
  await withOwner.close();
});

test("the own tools of a sign-in get a fresh access token, which the refresh token renews", async () => {
  const google: Connector = {
    id: "google",
    name: "Google",
    description: "Mail and calendars.",
    secretLabel: null,
    oauth: new URL(signInServer.url).origin,
    registered: true,
    scope: "openid email mail",
    authorizationParameters: { access_type: "offline" },
    tools: [
      {
        name: "google_token",
        description: "The access token that the call got.",
        parameters: Type.Object({}),
        execute: async (_args, accessToken) => accessToken,
      },
    ],
  };
  const withOwner = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    {
      directory: join(golem.app.config.dataDirectory, "integrations"),
      catalog: [google],
      owner: "alice@example.com",
    }
  );
  withOwner.setClient(alice, "google", {
    clientId: "own-client",
    clientSecret: "shh",
  });
  expect(withOwner.list(null, alice)[0]).toMatchObject({ connect: "sign-in" });
  const { url } = (await withOwner.connect(null, alice, "google")) as {
    url: string;
  };
  const page = new URL(url);
  expect(page.pathname).toBe("/authorize");
  expect(page.searchParams.get("access_type")).toBe("offline");
  expect(page.searchParams.has("resource")).toBe(false);
  const credential = await withOwner.finishConnect(
    null,
    alice,
    "google",
    `https://localhost/golem-sign-in?code=code-3&state=${page.searchParams.get("state")}`
  );
  expect(credential.label).toBe("anna@work.example");

  const [token, accounts] = await withOwner.tools(workspaceId);
  expect(accounts!.name).toBe("google_accounts");
  const refreshes = () =>
    tokenRequests.filter(
      (request) => request.get("grant_type") === "refresh_token"
    ).length;
  const before = refreshes();
  const turn = { userId: alice.id };
  expect(await token!.execute({}, turn)).toBe("access-refreshed");
  // The token stays until shortly before it expires.
  expect(await token!.execute({}, turn)).toBe("access-refreshed");
  expect(refreshes()).toBe(before + 1);
  expect(tokenRequests.at(-1)?.get("refresh_token")).toBe("refresh-1");
  withOwner.deleteCredential(null, alice, credential.id);
  await withOwner.close();
});

test("a turn picks one of its person's accounts by name, and lists them", async () => {
  const notes = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    {
      directory: join(golem.app.config.dataDirectory, "integrations"),
      catalog: [
        {
          id: "mail",
          name: "Mail",
          description: "Mail.",
          secretLabel: "Password",
          tools: [
            {
              name: "mail_secret",
              description: "The secret a call uses",
              parameters: Type.Object({}),
              execute: async (_args, password) => password,
            },
          ],
        },
      ],
    }
  );
  notes.addCredential(workspaceId, alice, "mail", {
    label: "family@example.com",
    secret: "family",
  });
  notes.addCredential(null, alice, "mail", {
    label: "work@example.com",
    secret: "work",
  });
  notes.addCredential(null, alice, "mail", {
    label: "me@example.com",
    secret: "me",
  });
  const [secret, accounts] = await notes.tools(workspaceId);
  expect(secret!.parameters).toMatchObject({
    properties: { account: { type: "string" } },
  });
  const turn = { userId: alice.id };
  expect(await secret!.execute({}, turn)).toBe("me");
  expect(await secret!.execute({ account: "work@example.com" }, turn)).toBe(
    "work"
  );
  expect(await secret!.execute({ account: "family@example.com" }, turn)).toBe(
    "family"
  );
  expect(await accounts!.execute({}, turn)).toEqual([
    { account: "me@example.com", of: "own" },
    { account: "work@example.com", of: "own" },
    { account: "family@example.com", of: "workspace" },
  ]);
  expect(await accounts!.execute({}, { userId: null })).toEqual([
    { account: "family@example.com", of: "workspace" },
  ]);
});

test("people link their WhatsApp number with a code, and agents read it through wacli", async () => {
  const directory = join(golem.app.config.dataDirectory, "whatsapp-test");
  const wacli = join(golem.app.config.dataDirectory, "wacli");
  // wacli as Golem runs it: linking gives a code, then links; a read answers with its arguments.
  await Bun.write(
    wacli,
    `#!/bin/sh
store="$2"
shift 2
case "$*" in
  "--events auth --phone"*)
    echo "Starting" >&2
    echo '{"event":"pair_code","data":{"code":"ABCD-1234"}}' >&2
    echo '{"event":"connected"}' >&2
    exec sleep 60 ;;
  "--events sync --follow")
    echo sync >> "$store/syncs"
    exec sleep 60 ;;
  "auth logout") touch "$store/logged-out" ;;
  *) printf '{"success":true,"data":{"store":"%s","command":"%s"},"error":null}' "$store" "$*" ;;
esac
`
  );
  await chmod(wacli, 0o755);
  const whatsApp = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    { directory, catalog: [whatsAppConnector(wacli)] }
  );
  expect(whatsApp.list(null, alice)[0]).toMatchObject({ connect: "phone" });
  await expect(whatsApp.finishConnect(null, alice, "whatsapp")).rejects.toThrow(
    "Start linking again"
  );
  expect(
    await whatsApp.connect(null, alice, "whatsapp", "+420 123 456 789")
  ).toEqual({
    code: "ABCD-1234",
  });
  const credential = await whatsApp.finishConnect(null, alice, "whatsapp");
  expect(credential.label).toBe("+420 123 456 789");

  const tools = await whatsApp.tools(workspaceId);
  expect(tools.map((tool) => tool.name)).toEqual([
    "whatsapp_chats",
    "whatsapp_messages",
    "whatsapp_search",
    "whatsapp_backfill",
    "whatsapp_contacts",
    "whatsapp_draft",
    "whatsapp_accounts",
  ]);
  const turn = { userId: alice.id };
  const store = join(directory, credential.id);
  expect(
    await tools[0]!.execute({ query: "family", unread: true }, turn)
  ).toEqual({
    store,
    command: "--json --read-only chats list --query family --unread",
  });
  // Two backfills at once wait for each other, and the sync starts again after them.
  const [first, second] = await Promise.all([
    tools[3]!.execute({ chat: "family@g.us", messages: 1000 }, turn),
    tools[3]!.execute({ chat: "partner@s.whatsapp.net" }, turn),
  ]);
  expect(first).toEqual({
    store,
    command:
      "--json --timeout 5m history backfill --chat family@g.us --count 500 --requests 2",
  });
  expect(second).toMatchObject({
    command: expect.stringContaining(
      "--chat partner@s.whatsapp.net --count 500 --requests 1"
    ),
  });
  const syncs = join(store, "syncs");
  for (let tries = 0; tries < 50 && (await readSyncs()) === 0; tries += 1) {
    await Bun.sleep(20);
  }
  expect(await readSyncs()).toBeGreaterThan(0);
  expect(
    await tools[5]!.execute(
      { phone: "+420 123 456 789", text: "On my way & late" },
      turn
    )
  ).toEqual({
    link: "https://wa.me/420123456789?text=On%20my%20way%20%26%20late",
  });

  whatsApp.deleteCredential(null, alice, credential.id);
  const unlinked = join(directory, "deleted", credential.id, "logged-out");
  for (let tries = 0; tries < 50 && !(await exists(unlinked)); tries += 1) {
    await Bun.sleep(20);
  }
  expect(await exists(unlinked)).toBe(true);
  expect(await whatsApp.tools(workspaceId)).toHaveLength(7);
  await expect(tools[0]!.execute({}, turn)).rejects.toThrow(
    "WhatsApp is not connected"
  );
  await whatsApp.close();

  async function readSyncs() {
    return (await exists(syncs))
      ? (await Bun.file(syncs).text()).trim().split("\n").length
      : 0;
  }
});

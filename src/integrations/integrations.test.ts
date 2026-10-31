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
/** A member who is not the server's owner. */
let notOwner: User;
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
  await golem.signIn("Eve", "eve@example.com");
  const eve = (await internalAdapter.findUserByEmail("eve@example.com"))!;
  notOwner = { id: eve.user.id, name: eve.user.name, email: eve.user.email };
  await golem.app.workspaces.addMember(workspaceId, alice, notOwner.email);
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
  await expect(
    integrations.addCredential(workspaceId, alice, "shop", {
      label: "Shop",
      secret: "x",
    })
  ).rejects.toThrow("Connect it by signing in");

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

test("a shared sign-in lists an MCP server's tools, else a private one", async () => {
  const signInTo = async (code: string) => {
    const { url } = (await integrations.connect(
      workspaceId,
      alice,
      "shop"
    )) as {
      url: string;
    };
    const state = new URL(url).searchParams.get("state")!;
    return integrations.finishConnect(
      workspaceId,
      alice,
      "shop",
      `https://localhost/golem-sign-in?code=${code}&state=${state}`
    );
  };
  const shared = await signInTo("code-1");
  integrations.setShared(workspaceId, alice, shared.id, true);
  const own = await signInTo("code-own");
  await integrations.tools(workspaceId);
  expect(connectedWith.at(-1)).toBe("access-1");
  integrations.deleteCredential(workspaceId, alice, shared.id);
  await integrations.tools(workspaceId);
  expect(connectedWith.at(-1)).toBe("access-own");
  integrations.deleteCredential(workspaceId, alice, own.id);
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

test("a turn uses its person's own credential, else a shared one, and only its owner shares or deletes it", async () => {
  await golem.signIn("Bob", "bob@example.com");
  const { internalAdapter } = await golem.app.auth.$context;
  const found = (await internalAdapter.findUserByEmail("bob@example.com"))!;
  const bob = {
    id: found.user.id,
    name: found.user.name,
    email: found.user.email,
  };
  await golem.app.workspaces.addMember(workspaceId, alice, bob.email);
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
  const token = async (userId: string | null) => {
    const [tool] = await notes.tools(workspaceId);
    return tool!.execute({}, { userId });
  };
  const family = await notes.addCredential(workspaceId, bob, "notes", {
    label: "Family",
    secret: "family",
  });
  expect(family).toMatchObject({ ownerId: bob.id, shared: false });
  const own = await notes.addCredential(workspaceId, alice, "notes", {
    label: "Mine",
    secret: "alice",
  });
  // Private: only Alice's turns use hers, and Bob's his.
  expect(await token(alice.id)).toBe("alice");
  expect(await token(bob.id)).toBe("family");
  await expect(token(null)).rejects.toThrow("Notes is not connected");
  expect(notes.list(workspaceId, alice)[0]!.credentials).toMatchObject([
    { label: "Mine" },
  ]);

  expect(() => notes.setShared(workspaceId, alice, family.id, true)).toThrow(
    "Not found"
  );
  expect(notes.setShared(workspaceId, bob, family.id, true)).toMatchObject({
    label: "Family",
    shared: true,
  });
  expect(reached).toEqual([workspaceId, workspaceId, workspaceId]);
  expect(await token(null)).toBe("family");
  expect(await token(alice.id)).toBe("alice");
  expect(notes.list(workspaceId, alice)[0]!.credentials).toMatchObject([
    { label: "Family", ownerName: "Bob", shared: true },
    { label: "Mine", shared: false },
  ]);
  expect(notes.list(workspaceId, bob)[0]!.credentials).toMatchObject([
    { label: "Family" },
  ]);

  expect(() => notes.deleteCredential(workspaceId, bob, own.id)).toThrow(
    "Not found"
  );
  expect(() => notes.deleteCredential(workspaceId, alice, family.id)).toThrow(
    "Not found"
  );
  notes.deleteCredential(workspaceId, alice, own.id);
  expect(await token(alice.id)).toBe("family");
  notes.deleteCredential(workspaceId, bob, family.id);
});

test("a tool that acts as a person asks its credential's owner every time, and only an agent in a thread can ask", async () => {
  const { internalAdapter } = await golem.app.auth.$context;
  const bobId = (await internalAdapter.findUserByEmail("bob@example.com"))!.user
    .id;
  const sent: string[] = [];
  const messenger = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    {
      directory: join(golem.app.config.dataDirectory, "integrations"),
      catalog: [
        {
          id: "messenger",
          name: "Messenger",
          description: "Messages.",
          secretLabel: "Session",
          // The secret is made from what the person pastes, and names the credential.
          secretFrom: async (input) => {
            if (!input.startsWith("curl ")) {
              throw new Error("Paste a cURL command");
            }
            return { secret: `session of ${input}`, label: "Family chat" };
          },
          tools: [
            {
              name: "messenger_send",
              description: "Sends a message",
              parameters: Type.Object({ text: Type.String() }),
              approval: ({ text }) => `Send: ${text}`,
              execute: async ({ text }, secret) => {
                sent.push(`${secret}: ${text}`);
                return { sent: true };
              },
            },
          ],
        },
      ],
    }
  );
  expect(messenger.list(workspaceId, alice)[0]!.labeled).toBe(false);
  await expect(
    messenger.addCredential(workspaceId, alice, "messenger", {
      secret: "hello",
    })
  ).rejects.toThrow("Paste a cURL command");
  const chat = await messenger.addCredential(workspaceId, alice, "messenger", {
    secret: "curl x",
  });
  expect(chat).toMatchObject({ label: "Family chat" });
  messenger.setShared(workspaceId, alice, chat.id, true);

  const [send] = await messenger.tools(workspaceId);
  const asked: [string, string | null][] = [];
  // Bob's turn uses Alice's shared credential, so Alice allows it.
  await send!.execute(
    { text: "Hi" },
    {
      userId: bobId,
      approve: async (text, approverId) => {
        asked.push([text, approverId]);
      },
    }
  );
  await expect(
    send!.execute(
      { text: "Again" },
      {
        userId: bobId,
        approve: () => Promise.reject(new Error("Alice did not allow this.")),
      }
    )
  ).rejects.toThrow("Alice did not allow this.");
  // A routine's script cannot ask.
  await expect(
    send!.execute({ text: "From a script" }, { userId: bobId })
  ).rejects.toThrow("Only an agent in a thread can use messenger_send");
  expect(asked).toEqual([["Send: Hi", alice.id]]);
  expect(sent).toEqual(["session of curl x: Hi"]);
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
  await expect(add()).rejects.toThrow("Address is required");
  await expect(add("file:///etc")).rejects.toThrow("http:// or https://");
  await add("http://home.local:8123");
  expect(home.list(workspaceId, alice)[0]!.address).toBe(true);
  const [tool] = await home.tools(workspaceId);
  expect(await tool!.execute({}, { userId: alice.id })).toEqual({
    address: "http://home.local:8123/",
    secret: "token",
  });
});

test("a secret of a connector with an account keeps the account, which names the credential", async () => {
  const thermostat = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    {
      directory: join(golem.app.config.dataDirectory, "integrations"),
      catalog: [
        {
          id: "thermostat",
          name: "Thermostat",
          description: "The heating.",
          secretLabel: "Password",
          username: "Email",
          tools: [
            {
              name: "thermostat_secret",
              description: "The secret a call gets",
              parameters: Type.Object({}),
              execute: async (_args, secret) => JSON.parse(secret),
            },
          ],
        },
      ],
    }
  );
  const add = (username?: string) =>
    thermostat.addCredential(workspaceId, alice, "thermostat", {
      secret: "pw",
      ...(username === undefined ? {} : { username }),
    });
  await expect(add()).rejects.toThrow("Email is required");
  expect((await add(" anna@example.com ")).label).toBe("anna@example.com");
  expect(thermostat.list(workspaceId, alice)[0]).toMatchObject({
    labeled: false,
    username: "Email",
  });
  const [tool] = await thermostat.tools(workspaceId);
  expect(await tool!.execute({}, { userId: alice.id })).toEqual({
    username: "anna@example.com",
    secret: "pw",
  });
});

test("a sign-in server that does not publish its endpoints signs in at the connector's own", async () => {
  const { origin } = new URL(signInServer.url);
  const station: Connector = {
    id: "station",
    name: "Station",
    description: "The weather.",
    secretLabel: null,
    oauth: `${origin}/station`,
    oauthEndpoints: {
      authorization: `${origin}/oauth2/authorize`,
      token: `${origin}/token`,
    },
    registered: true,
    tools: [],
  };
  const withOwner = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    {
      directory: join(golem.app.config.dataDirectory, "integrations"),
      catalog: [station],
      owner: "alice@example.com",
    }
  );
  withOwner.setClient(alice, "station", {
    clientId: "own-client",
    clientSecret: "shh",
  });
  const { url } = (await withOwner.connect(workspaceId, alice, "station")) as {
    url: string;
  };
  const page = new URL(url);
  expect(page.pathname).toBe("/oauth2/authorize");
  const credential = await withOwner.finishConnect(
    workspaceId,
    alice,
    "station",
    `https://localhost/golem-sign-in?code=code-4&state=${page.searchParams.get("state")}`
  );
  expect(credential.label).toBe("anna@work.example");
  expect(tokenRequests.at(-1)?.get("client_secret")).toBe("shh");
  withOwner.deleteCredential(workspaceId, alice, credential.id);
  await withOwner.close();
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
  expect(withOwner.list(workspaceId, notOwner)).toEqual([]);
  expect(withOwner.list(workspaceId, alice)[0]!.client).toEqual({
    clientId: null,
    changeable: true,
  });
  await expect(withOwner.connect(workspaceId, alice, "chat")).rejects.toThrow(
    "The server's owner has not set the client of Chat"
  );
  expect(() =>
    withOwner.setClient(notOwner, "chat", { clientId: "x", clientSecret: "y" })
  ).toThrow("Only the server's owner sets the client");
  withOwner.setClient(alice, "chat", {
    clientId: " own-client ",
    clientSecret: "shh",
  });
  expect(withOwner.list(workspaceId, notOwner)[0]!.client).toEqual({
    clientId: "own-client",
    changeable: false,
  });

  const { url } = (await withOwner.connect(workspaceId, alice, "chat")) as {
    url: string;
  };
  const page = new URL(url);
  expect(page.searchParams.get("client_id")).toBe("own-client");
  expect(page.searchParams.get("scope")).toBe("search chat:write");
  const credential = await withOwner.finishConnect(
    workspaceId,
    alice,
    "chat",
    `https://localhost/golem-sign-in?code=code-2&state=${page.searchParams.get("state")}`
  );
  expect(credential.label).toBe("anna@work.example");
  expect((await withOwner.tools(workspaceId)).map((tool) => tool.name)).toEqual(
    ["chat_search_products", "chat_cart", "chat_accounts"]
  );
  withOwner.deleteCredential(workspaceId, alice, credential.id);
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
  expect(withOwner.list(workspaceId, alice)[0]).toMatchObject({
    connect: "sign-in",
  });
  const { url } = (await withOwner.connect(workspaceId, alice, "google")) as {
    url: string;
  };
  const page = new URL(url);
  expect(page.pathname).toBe("/authorize");
  expect(page.searchParams.get("access_type")).toBe("offline");
  expect(page.searchParams.has("resource")).toBe(false);
  const credential = await withOwner.finishConnect(
    workspaceId,
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
  withOwner.deleteCredential(workspaceId, alice, credential.id);
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
  const family = await notes.addCredential(workspaceId, alice, "mail", {
    label: "family@example.com",
    secret: "family",
  });
  notes.setShared(workspaceId, alice, family.id, true);
  await notes.addCredential(workspaceId, alice, "mail", {
    label: "work@example.com",
    secret: "work",
  });
  await notes.addCredential(workspaceId, alice, "mail", {
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
    { account: "family@example.com", of: "own" },
  ]);
  expect(await accounts!.execute({}, { userId: null })).toEqual([
    { account: "family@example.com", of: "shared" },
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
  expect(whatsApp.list(workspaceId, alice)[0]).toMatchObject({
    connect: "phone",
  });
  await expect(
    whatsApp.finishConnect(workspaceId, alice, "whatsapp")
  ).rejects.toThrow("Start linking again");
  expect(
    await whatsApp.connect(workspaceId, alice, "whatsapp", "+420 123 456 789")
  ).toEqual({
    code: "ABCD-1234",
  });
  const credential = await whatsApp.finishConnect(
    workspaceId,
    alice,
    "whatsapp"
  );
  expect(credential.label).toBe("+420 123 456 789");

  const tools = await whatsApp.tools(workspaceId);
  expect(tools.map((tool) => tool.name)).toEqual([
    "whatsapp_chats",
    "whatsapp_messages",
    "whatsapp_search",
    "whatsapp_backfill",
    "whatsapp_contacts",
    "whatsapp_draft",
    "whatsapp_send",
    "whatsapp_send_file",
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
  const allowed: string[] = [];
  expect(
    await tools[6]!.execute(
      { to: "family@g.us", text: "-Home soon" },
      {
        ...turn,
        approve: async (text, approverId) => {
          allowed.push(`${approverId}: ${text}`);
        },
      }
    )
  ).toEqual({
    store,
    command: "--json send text --to=family@g.us --message=-Home soon",
  });
  expect(
    await tools[7]!.execute(
      { to: "family@g.us", file: "f1", caption: "Tonight" },
      {
        ...turn,
        file: async () => ({ path: "/files/f1-menu.pdf", name: "menu.pdf" }),
        approve: async (text, approverId) => {
          allowed.push(`${approverId}: ${text}`);
        },
      }
    )
  ).toEqual({
    store,
    command:
      "--json send file --to=family@g.us --file=/files/f1-menu.pdf --filename=menu.pdf --caption=Tonight",
  });
  expect(allowed).toEqual([
    `${alice.id}: Send on WhatsApp to family@g.us: -Home soon`,
    `${alice.id}: Send on WhatsApp to family@g.us: menu.pdf\n\nTonight`,
  ]);

  whatsApp.deleteCredential(workspaceId, alice, credential.id);
  const unlinked = join(directory, "deleted", credential.id, "logged-out");
  for (let tries = 0; tries < 50 && !(await exists(unlinked)); tries += 1) {
    await Bun.sleep(20);
  }
  expect(await exists(unlinked)).toBe(true);
  expect(await whatsApp.tools(workspaceId)).toHaveLength(9);
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

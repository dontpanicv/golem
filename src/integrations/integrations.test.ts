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
    return Response.json({
      access_token: "access-1",
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

test("a connector with Golem's own client signs in to all its servers at once, and hides the tools that send", async () => {
  const servers = ["/mcp", "/calendar"].map(
    (path) => new URL(path, signInServer.url).href
  );
  const google: Connector = {
    id: "google",
    name: "Google",
    description: "Mail and calendars.",
    secretLabel: null,
    tools: [],
    mcp: servers,
    registered: true,
    scope: "openid email mail",
    authorizationParameters: { access_type: "offline" },
    hiddenTools: ["checkout", "delete_event"],
  };
  const options = {
    directory: join(golem.app.config.dataDirectory, "integrations"),
    catalog: [google],
    transport: (address: URL) => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      (address.pathname === "/calendar"
        ? calendarServer()
        : shopServer()
      ).connect(serverSide);
      return clientSide;
    },
  };
  const { database, workspaces } = golem.app;
  // Without its client in golem.toml, Golem does not offer it.
  expect(
    new Integrations(database, Secrets.forTests(), workspaces, options).list(
      null,
      alice
    )
  ).toEqual([]);
  const withClient = new Integrations(
    database,
    Secrets.forTests(),
    workspaces,
    {
      ...options,
      clients: { google: { clientId: "own-client", clientSecret: "shh" } },
    }
  );

  const { url } = (await withClient.connect(null, alice, "google")) as {
    url: string;
  };
  const page = new URL(url);
  expect(page.searchParams.get("client_id")).toBe("own-client");
  expect(page.searchParams.get("scope")).toBe("openid email mail");
  expect(page.searchParams.get("access_type")).toBe("offline");
  // One token serves both servers, so it names neither.
  expect(page.searchParams.has("resource")).toBe(false);
  const state = page.searchParams.get("state");
  const credential = await withClient.finishConnect(
    null,
    alice,
    "google",
    `https://localhost/golem-sign-in?code=code-2&state=${state}`
  );
  expect(credential.label).toBe("anna@work.example");

  const tools = await withClient.tools(workspaceId);
  expect(tools.map((tool) => tool.name)).toEqual([
    "google_search_products",
    "google_cart",
    "google_list_events",
    "google_accounts",
  ]);
  expect(
    await tools[2]!.execute(
      { account: "Anna@work.example" },
      { userId: alice.id }
    )
  ).toBe("No events.");
  await expect(
    tools[2]!.execute({ account: "anna@home.example" }, { userId: alice.id })
  ).rejects.toThrow(
    "Google has no account anna@home.example; it has anna@work.example."
  );
  withClient.deleteCredential(null, alice, credential.id);
  await withClient.close();
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
  "--events sync --follow") exec sleep 60 ;;
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
    command: "--read-only --json chats list --query family --unread",
  });
  expect(
    await tools[4]!.execute(
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
  expect(await whatsApp.tools(workspaceId)).toHaveLength(6);
  await expect(tools[0]!.execute({}, turn)).rejects.toThrow(
    "WhatsApp is not connected"
  );
  await whatsApp.close();
});

/** A second MCP server of the same sign-in, as Google Calendar is Gmail's. */
function calendarServer(): Server {
  const server = new Server(
    { name: "calendar", version: "1" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ["list_events", "delete_event"].map((name) => ({
      name,
      inputSchema: { type: "object" as const, properties: {} },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "No events." }],
  }));
  return server;
}

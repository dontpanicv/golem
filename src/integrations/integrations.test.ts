import { afterAll, beforeAll, expect, test } from "bun:test";
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
    mcp: new URL("/mcp", signInServer.url).href,
  };
  integrations = new Integrations(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    {
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
    tokenRequests.push(new URLSearchParams(await request.text()));
    return Response.json({
      access_token: "access-1",
      token_type: "Bearer",
      refresh_token: "refresh-1",
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

  const { url } = await integrations.connect(workspaceId, alice, "shop");
  const page = new URL(url);
  expect(page.pathname).toBe("/authorize");
  expect(page.searchParams.get("client_id")).toBe("golem-client");
  expect(page.searchParams.get("redirect_uri")).toBe(
    "http://localhost/golem-sign-in"
  );
  expect(page.searchParams.get("code_challenge_method")).toBe("S256");
  const state = page.searchParams.get("state")!;
  // The sign-in page ends at the loopback address, which the person pastes.
  const address = `http://localhost/golem-sign-in?code=code-1&state=${state}`;

  await expect(
    integrations.finishConnect(workspaceId, alice, "shop", "http://localhost/")
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
  expect(shop).toMatchObject({ secretLabel: null });
  expect(shop!.credentials).toMatchObject([
    { label: "Shop", ownerName: "Alice" },
  ]);

  const tools = await integrations.tools(workspaceId);
  expect(tools.map((tool) => tool.name)).toEqual([
    "shop_search_products",
    "shop_cart",
    "shop_checkout",
  ]);
  expect(connectedWith.at(-1)).toBe("access-1");
  const [search, cart, checkout] = tools;
  expect(search!.outputSchema).toBeDefined();
  expect(await search!.execute({ query: "milk" })).toEqual({
    products: [{ name: "milk 1 l" }],
  });
  expect(await cart!.execute({})).toBe("The cart is empty.");
  await expect(checkout!.execute({})).rejects.toThrow(
    "Paying is not possible."
  );
  expect(integrations.namespaces()).toEqual([
    { name: "shop", prefix: "shop_", description: "Groceries." },
  ]);

  integrations.deleteCredential(workspaceId, alice, shop!.credentials[0]!.id);
  expect(await integrations.tools(workspaceId)).toEqual([]);
});

test("a sign-in that did not finish adds nothing", async () => {
  const { url } = await integrations.connect(workspaceId, alice, "shop");
  const state = new URL(url).searchParams.get("state")!;
  await expect(
    integrations.finishConnect(
      workspaceId,
      alice,
      "shop",
      `http://localhost/golem-sign-in?error=access_denied&state=${state}`
    )
  ).rejects.toThrow("The sign-in did not finish");
  expect(integrations.list(workspaceId, alice)[0]!.credentials).toEqual([]);
});

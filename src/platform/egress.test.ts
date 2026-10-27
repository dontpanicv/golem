import { afterAll, expect, test } from "bun:test";
import { connect } from "node:net";
import { Egress, isLocal, isPublic, resolvePublic } from "./egress.ts";

const web = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/away") {
      return Response.redirect(
        `http://127.0.0.2:${new URL(request.url).port}/`,
        302
      );
    }
    return new Response(`page ${pathname} for ${request.headers.get("host")}`);
  },
});
afterAll(() => web.stop(true));

test("only public addresses are public, also in their IPv4-mapped form", () => {
  for (const address of [
    "127.0.0.1",
    "::1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.40",
    "169.254.169.254",
    "100.64.0.1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "0.0.0.0",
    "::",
    "224.0.0.251",
    "64:ff9b::a00:1",
    "localhost",
  ]) {
    expect([address, isPublic(address)]).toEqual([address, false]);
  }
  for (const address of ["8.8.8.8", "2606:4700::1", "::ffff:8.8.8.8"]) {
    expect([address, isPublic(address)]).toEqual([address, true]);
  }
});

test("local addresses are this machine, link-local, or none; LAN and VPN addresses are not", () => {
  for (const address of [
    "127.0.0.1",
    "::1",
    "169.254.169.254",
    "fe80::1",
    "0.0.0.0",
    "::",
    "::ffff:127.0.0.1",
    "224.0.0.1",
  ]) {
    expect([address, isLocal(address)]).toEqual([address, true]);
  }
  for (const address of ["192.168.1.40", "10.0.0.2", "100.101.102.103"]) {
    expect([address, isLocal(address)]).toEqual([address, false]);
  }
});

test("a host name resolves once and is refused when one of its addresses is not public", async () => {
  await expect(resolvePublic("localhost")).rejects.toThrow(
    "localhost is not a public address"
  );
  expect(await resolvePublic("[::1]", () => true)).toBe("::1");
});

test("the proxy refuses a tunnel, a request, and a redirect to an address that is not allowed", async () => {
  const proxy = `http://127.0.0.1:${await new Egress().port()}`;
  await expect(
    fetch(`https://localhost:${web.port}/`, { proxy })
  ).rejects.toThrow();
  expect((await fetch(`http://127.0.0.1:${web.port}/`, { proxy })).status).toBe(
    403
  );

  const loopbackOnly = `http://127.0.0.1:${await new Egress((address) => address === "127.0.0.1").port()}`;
  const page = await fetch(`http://127.0.0.1:${web.port}/a?b=c`, {
    proxy: loopbackOnly,
  });
  expect(await page.text()).toBe(`page /a for 127.0.0.1:${web.port}`);
  // The redirect is a new request, which the proxy checks again.
  expect(
    (await fetch(`http://127.0.0.1:${web.port}/away`, { proxy: loopbackOnly }))
      .status
  ).toBe(403);
});

test("Chrome's SOCKS5 tunnel connects to the checked address, and a refused one gets the rules' reply", async () => {
  const exchange = async (port: number, host: string) =>
    new Promise<Buffer>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        const name = Buffer.from(host);
        const portBytes = Buffer.alloc(2);
        portBytes.writeUInt16BE(web.port!);
        socket.write(
          Buffer.concat([
            Buffer.from([5, 1, 0]),
            Buffer.from([5, 1, 0, 3, name.length]),
            name,
            portBytes,
            Buffer.from(
              `GET /socks HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`
            ),
          ])
        );
      });
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("close", () => resolve(Buffer.concat(chunks)));
      socket.on("error", reject);
    });
  const refused = await exchange(await new Egress().port(), "localhost");
  expect([...refused]).toEqual([5, 0, 5, 2, 0, 1, 0, 0, 0, 0, 0, 0]);
  const allowed = await exchange(
    await new Egress(() => true).port(),
    "127.0.0.1"
  );
  expect([...allowed.subarray(0, 4)]).toEqual([5, 0, 5, 0]);
  expect(allowed.toString()).toEndWith("page /socks for 127.0.0.1");
});

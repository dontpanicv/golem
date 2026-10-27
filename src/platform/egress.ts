import { lookup } from "node:dns/promises";
import { BlockList, connect, createServer, isIP, type Socket } from "node:net";

/** Addresses that are not on the public internet; IPv4-mapped IPv6 addresses match their IPv4 rules. */
const PRIVATE = blockList([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]);
/** Loopback, link-local, unspecified, and multicast addresses: this machine, or no machine of a network. */
const LOCAL = blockList([
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
  ["::", 127],
  ["fe80::", 10],
  ["ff00::", 8],
]);
/** The most bytes of a proxy request before its tunnel opens. */
const MAX_REQUEST = 16 * 1024;

/** Whether an IP address is on the public internet; a host name is not an address. */
export function isPublic(address: string): boolean {
  const family = isIP(address);
  return (
    family !== 0 && !PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6")
  );
}

/** Whether an IP address is this machine, a link-local address, or no single machine. */
export function isLocal(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && LOCAL.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** The address of a host, resolved once; refused when any of its addresses is not `allowed`. */
export async function resolvePublic(
  host: string,
  allowed: (address: string) => boolean = isPublic
): Promise<string> {
  const bare = host.replace(/^\[(.*)\]$/, "$1");
  const addresses = isIP(bare)
    ? [bare]
    : (await lookup(bare, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || !addresses.every(allowed)) {
    throw new Error(`${host} is not a public address`);
  }
  return addresses[0]!;
}

/**
 * A proxy on 127.0.0.1 through which agents reach the web: SOCKS5 for Chrome, and HTTP `CONNECT` and absolute-form
 * requests for `fetch`. Each tunnel resolves its host once and connects to the address it checked, so a redirect, which
 * opens a new tunnel, and a DNS answer that changes are checked too.
 */
export class Egress {
  private listening: Promise<number> | undefined;

  constructor(
    private readonly allowed: (address: string) => boolean = isPublic
  ) {}

  /** The proxy's port; the first call starts it. */
  port(): Promise<number> {
    this.listening ??= new Promise((resolve, reject) => {
      const server = createServer((client) => {
        this.tunnel(client).catch(() => client.destroy());
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        // It must not keep Golem or a test from ending.
        server.unref();
        resolve((server.address() as { port: number }).port);
      });
    });
    return this.listening;
  }

  private async tunnel(client: Socket): Promise<void> {
    const reader = new Reader(client);
    const [first] = await reader.read(1, false);
    if (first === 5) {
      await this.socks(client, reader);
    } else {
      await this.http(client, reader);
    }
  }

  /** SOCKS5 without authentication, CONNECT only (RFC 1928). */
  private async socks(client: Socket, reader: Reader): Promise<void> {
    const greeting = await reader.read(2);
    await reader.read(greeting[1]!);
    client.write(Buffer.from([5, 0]));
    const head = await reader.read(4);
    const reply = (code: number) =>
      Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
    let host: string;
    if (head[3] === 1) {
      host = [...(await reader.read(4))].join(".");
    } else if (head[3] === 4) {
      const bytes = await reader.read(16);
      host = Array.from({ length: 8 }, (_, index) =>
        bytes.readUInt16BE(index * 2).toString(16)
      ).join(":");
    } else if (head[3] === 3) {
      const [length] = await reader.read(1);
      host = (await reader.read(length!)).toString("latin1");
    } else {
      client.end(reply(8));
      return;
    }
    const port = (await reader.read(2)).readUInt16BE(0);
    if (head[1] !== 1) {
      client.end(reply(7));
      return;
    }
    const upstream = await this.open(host, port).catch(() => null);
    if (!upstream) {
      // 2: not allowed by the rules.
      client.end(reply(2));
      return;
    }
    client.write(reply(0));
    pipe(client, upstream, reader.rest());
  }

  /** `CONNECT host:port`, or a request for an `http:` address in absolute form, which goes on as `Connection: close`. */
  private async http(client: Socket, reader: Reader): Promise<void> {
    const head = (await reader.until("\r\n\r\n")).toString("latin1");
    const [requestLine = "", ...headers] = head.split("\r\n");
    const [method = "", target = "", version = "HTTP/1.1"] =
      requestLine.split(" ");
    const refuse = (status: string) =>
      client.end(
        `HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      );
    if (method === "CONNECT") {
      const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
      const upstream =
        match &&
        (await this.open(match[1]!, Number(match[2])).catch(() => null));
      if (!upstream) {
        refuse("403 Forbidden");
        return;
      }
      client.write(`${version} 200 Connection established\r\n\r\n`);
      pipe(client, upstream, reader.rest());
      return;
    }
    const url = URL.parse(target);
    if (url?.protocol !== "http:") {
      refuse("400 Bad Request");
      return;
    }
    const upstream = await this.open(
      url.hostname,
      Number(url.port || 80)
    ).catch(() => null);
    if (!upstream) {
      refuse("403 Forbidden");
      return;
    }
    // The tunnel serves this one request, so a reused connection cannot carry a request for another host.
    const kept = headers.filter(
      (line) => line && !/^(proxy-)?connection\s*:/i.test(line)
    );
    const request = [
      `${method} ${url.pathname}${url.search} ${version}`,
      ...kept,
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    pipe(
      client,
      upstream,
      Buffer.concat([Buffer.from(request, "latin1"), reader.rest()])
    );
  }

  /** A connection to the one address of `host` that was checked. */
  private async open(host: string, port: number): Promise<Socket> {
    const address = await resolvePublic(host, this.allowed);
    return new Promise((resolve, reject) => {
      const socket = connect({ host: address, port }, () => resolve(socket));
      // It stays: an error before the pipe takes the socket must not end Golem; one after it is a no-op.
      socket.on("error", reject);
    });
  }
}

function blockList(subnets: readonly [string, number][]): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of subnets) {
    list.addSubnet(network, prefix, isIP(network) === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

/** Sends `first`, then copies both ways until either side closes; the client still gets what the upstream sent. */
function pipe(client: Socket, upstream: Socket, first: Buffer): void {
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close).on("close", () => upstream.destroy());
  upstream.on("error", close).on("close", () => client.end());
  if (client.destroyed) {
    // The client left while the host resolved.
    upstream.destroy();
    return;
  }
  if (first.length) {
    upstream.write(first);
  }
  client.pipe(upstream);
  upstream.pipe(client);
  client.resume();
}

/** Reads a proxy request from a socket, a few bytes at a time, before its tunnel takes the socket over. */
class Reader {
  private buffered = Buffer.alloc(0);
  private wake: (() => void) | undefined;
  private ended = false;

  constructor(private readonly socket: Socket) {
    socket.on("data", this.receive);
    // A client that resets before its tunnel opens only closes.
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      this.ended = true;
      this.wake?.();
    });
  }

  private readonly receive = (chunk: Buffer) => {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length > MAX_REQUEST) {
      this.socket.destroy();
    }
    this.wake?.();
  };

  /** The next `size` bytes; `consume: false` leaves them for the next read. */
  async read(size: number, consume = true): Promise<Buffer> {
    await this.wait(() => this.buffered.length >= size);
    const bytes = this.buffered.subarray(0, size);
    if (consume) {
      this.buffered = this.buffered.subarray(size);
    }
    return bytes;
  }

  /** The bytes up to and with `end`. */
  async until(end: string): Promise<Buffer> {
    await this.wait(() => this.buffered.includes(end));
    return this.read(this.buffered.indexOf(end) + end.length);
  }

  /** What came after the request; the socket stops reading until a pipe takes it. */
  rest(): Buffer {
    this.socket.off("data", this.receive);
    this.socket.pause();
    return this.buffered;
  }

  private async wait(ready: () => boolean): Promise<void> {
    while (!ready()) {
      if (this.ended) {
        throw new Error("The client closed");
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

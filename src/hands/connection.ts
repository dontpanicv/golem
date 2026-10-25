import { createHash, type KeyObject, sign, X509Certificate } from "node:crypto";
import { connect } from "node:tls";

/** A machine running `hands`, paired with a workspace. */
export interface Machine {
  readonly addresses: readonly string[];
  readonly arch: string;
  /** SHA-256 of the listener's certificate, hex. Connections to any other certificate are refused. */
  readonly certSha256: string;
  readonly hostname: string | null;
  readonly id: string;
  readonly name: string;
  readonly os: string;
  readonly pairedAt: number;
  readonly port: number;
  readonly version: string;
}

export interface Reply {
  readonly json: Record<string, unknown>;
  readonly payload: Uint8Array;
}

/** The identity a workspace signs in to its machines with. */
export interface Identity {
  readonly privateKey: KeyObject;
  /** The raw 32-byte Ed25519 public key, base64. */
  readonly publicKey: string;
}

export class HandsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The connection is gone; the request may not have reached the machine. */
    readonly connectionLost = false
  ) {
    super(message);
  }
}

const PROTOCOL = 1;
const MAX_FRAME = 16 * 1024 * 1024;
const OPEN_TIMEOUT = 6000;
/** hands pings every 5 s, so silence this long means the machine is gone even when TCP has not noticed yet. */
const SILENCE_LIMIT = 20_000;
const FrameType = {
  request: 1,
  result: 2,
  error: 3,
  event: 4,
  cancel: 5,
  ping: 6,
} as const;

/**
 * One authenticated connection to a machine's `hands` listener (hands/docs/pairing.md §2): WebSocket over TLS
 * pinned to the machine's certificate, the hello/auth/ready handshake, then one protocol frame per binary message
 * (hands/docs/protocol.md). Requests are matched to replies by id.
 */
export class HandsConnection {
  /** What the machine reported in `hello`: home, os, arch, version, features. */
  info: Record<string, unknown> = {};
  closed = false;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (reply: Reply) => void;
      reject: (error: Error) => void;
    }
  >();
  private lastHeard = Date.now();
  private readonly pinger: ReturnType<typeof setInterval>;

  private constructor(
    readonly machine: Machine,
    private readonly socket: WebSocket
  ) {
    socket.onmessage = (event) => this.receive(event.data as ArrayBuffer);
    socket.onclose = () => this.close();
    socket.onerror = () => this.close();
    this.pinger = setInterval(() => this.ping(), 5000);
  }

  /**
   * Tries every address of the machine at once and keeps the first that authenticates. If none does, the error says
   * what happened at each address, so a dead VPN address does not hide why the LAN one failed.
   */
  static async open(
    machine: Machine,
    identity: Identity
  ): Promise<HandsConnection> {
    const hosts = [
      ...new Set([machine.hostname, ...machine.addresses].filter(Boolean)),
    ] as string[];
    const attempts = hosts.map((host) =>
      HandsConnection.openAt(host, machine, identity).catch((error: Error) => {
        throw new Error(`${host}: ${error.message}`);
      })
    );
    try {
      const winner = await Promise.any(attempts);
      for (const attempt of attempts) {
        attempt
          .then((other) => other !== winner && other.close())
          .catch(() => {
            // A slower address that failed after another one won.
          });
      }
      return winner;
    } catch (error) {
      const failures = (error as AggregateError).errors ?? [];
      throw new Error(
        `${machine.name} is unreachable: ${failures.map((failure: Error) => failure.message).join("; ") || "it has no address"}`,
        { cause: error }
      );
    }
  }

  private static async openAt(
    host: string,
    machine: Machine,
    identity: Identity
  ): Promise<HandsConnection> {
    const certificate = await pinnedCertificate(host, machine);
    const authority = host.includes(":") ? `[${host}]` : host;
    const socket = new WebSocket(`wss://${authority}:${machine.port}/v1`, {
      tls: {
        // The machine's own certificate is the only trusted one, and its hash must match the pin.
        ca: certificate,
        checkServerIdentity: (_host: string, peer: { raw: Buffer }) =>
          sha256Hex(peer.raw) === machine.certSha256
            ? undefined
            : new Error("the certificate does not match the pin"),
      },
    } as Bun.WebSocketOptions);
    socket.binaryType = "arraybuffer";
    try {
      await withTimeout(handshake(socket, machine, identity), OPEN_TIMEOUT);
    } catch (error) {
      socket.close();
      throw error;
    }
    const connection = new HandsConnection(machine, socket);
    connection.info = (
      await connection.request("hello", { protocol: PROTOCOL })
    ).json;
    return connection;
  }

  /** Sends a request and waits for its result; aborting `signal` cancels the request on the machine. */
  request(
    op: string,
    fields: Record<string, unknown> = {},
    options: { payload?: Uint8Array; signal?: AbortSignal } = {}
  ): Promise<Reply> {
    if (this.closed) {
      return Promise.reject(lostConnection(this.machine));
    }
    options.signal?.throwIfAborted();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<Reply>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        this.send(encodeFrame(FrameType.cancel, id, {}));
        reject(options.signal!.reason);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (reply) => {
          options.signal?.removeEventListener("abort", abort);
          resolve(reply);
        },
        reject: (error) => {
          options.signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.send(
        encodeFrame(FrameType.request, id, { ...fields, op }, options.payload)
      );
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.pinger);
    this.socket.close();
    for (const { reject } of this.pending.values()) {
      reject(lostConnection(this.machine));
    }
    this.pending.clear();
  }

  private send(frame: Uint8Array): void {
    if (!this.closed) {
      this.socket.send(frame);
    }
  }

  private ping(): void {
    if (Date.now() - this.lastHeard > SILENCE_LIMIT) {
      this.close();
      return;
    }
    this.send(encodeFrame(FrameType.ping, 0, {}));
  }

  private receive(data: ArrayBuffer): void {
    this.lastHeard = Date.now();
    if (!(data instanceof ArrayBuffer)) {
      return;
    }
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(new Uint8Array(data));
    } catch {
      // A machine that breaks the protocol gets no more requests.
      this.close();
      return;
    }
    if (frame.type === FrameType.result) {
      this.pending.get(frame.id)?.resolve(frame);
      this.pending.delete(frame.id);
    } else if (frame.type === FrameType.error) {
      this.pending
        .get(frame.id)
        ?.reject(
          new HandsError(
            String(frame.json.code ?? "unknown"),
            String(frame.json.message ?? frame.json.code)
          )
        );
      this.pending.delete(frame.id);
    }
    // Pings and exec output events are not used: agents run commands as jobs.
  }
}

/**
 * The machine's certificate as PEM, read with an unverified TLS connection and accepted only when its SHA-256 is the
 * pin; the WebSocket then trusts exactly this certificate.
 */
function pinnedCertificate(host: string, machine: Machine): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve, reject) => {
      const socket = connect(
        {
          host,
          port: machine.port,
          servername: "hands",
          rejectUnauthorized: false,
        },
        () => {
          const { raw } = socket.getPeerCertificate();
          socket.destroy();
          if (sha256Hex(raw) === machine.certSha256) {
            resolve(new X509Certificate(raw).toString());
          } else {
            reject(new Error("the certificate does not match the pin"));
          }
        }
      );
      socket.on("error", reject);
    }),
    OPEN_TIMEOUT
  );
}

async function handshake(
  socket: WebSocket,
  machine: Machine,
  identity: Identity
): Promise<void> {
  const messages = textMessages(socket);
  const hello = await messages.next();
  if (hello.type !== "hello" || typeof hello.nonce !== "string") {
    throw new Error("unexpected greeting");
  }
  const signature = sign(
    null,
    Buffer.from(`mycroft-auth:${machine.certSha256}:${hello.nonce}`),
    identity.privateKey
  ).toString("base64");
  socket.send(
    JSON.stringify({
      type: "auth",
      publicKey: identity.publicKey,
      signature,
    })
  );
  const answer = await messages.next();
  messages.stop();
  if (answer.type !== "ready") {
    throw new HandsError(
      String(answer.code ?? "unauthorized"),
      `${machine.name} refused this workspace; pair it again`
    );
  }
}

/** The JSON text messages of a socket before `ready`, one at a time. */
function textMessages(socket: WebSocket) {
  const queue: Record<string, unknown>[] = [];
  const waiting: {
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }[] = [];
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    for (const waiter of waiting.splice(0)) {
      waiter.reject(error);
    }
  };
  socket.onmessage = (event) => {
    let message: Record<string, unknown> = {};
    try {
      message = typeof event.data === "string" ? JSON.parse(event.data) : {};
    } catch {
      // Not JSON: the handshake then fails on the empty message.
    }
    const waiter = waiting.shift();
    if (waiter) {
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  };
  socket.onerror = (event) =>
    fail(new Error((event as ErrorEvent).message || "connection failed"));
  socket.onclose = () => fail(new Error("connection closed"));
  return {
    next(): Promise<Record<string, unknown>> {
      const message = queue.shift();
      if (message) {
        return Promise.resolve(message);
      }
      if (failure) {
        return Promise.reject(failure);
      }
      return new Promise((resolve, reject) =>
        waiting.push({ resolve, reject })
      );
    },
    stop() {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
    },
  };
}

/** Every frame: u32 length (bytes after it) · u8 type · u32 id · u32 JSON length · JSON · payload. Big-endian. */
export function encodeFrame(
  type: number,
  id: number,
  json: Record<string, unknown>,
  payload: Uint8Array = new Uint8Array()
): Uint8Array {
  const body = Buffer.from(JSON.stringify(json));
  const frame = new Uint8Array(13 + body.length + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 9 + body.length + payload.length);
  view.setUint8(4, type);
  view.setUint32(5, id);
  view.setUint32(9, body.length);
  frame.set(body, 13);
  frame.set(payload, 13 + body.length);
  return frame;
}

/** One whole frame, as the listener sends one per WebSocket message. */
export function decodeFrame(frame: Uint8Array): Reply & {
  readonly type: number;
  readonly id: number;
} {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = view.getUint32(0);
  const jsonLength = view.getUint32(9);
  if (
    length !== frame.length - 4 ||
    length > MAX_FRAME ||
    9 + jsonLength > length
  ) {
    throw new Error("bad frame");
  }
  const json = jsonLength
    ? JSON.parse(Buffer.from(frame.subarray(13, 13 + jsonLength)).toString())
    : {};
  return {
    type: view.getUint8(4),
    id: view.getUint32(5),
    json,
    payload: frame.subarray(13 + jsonLength),
  };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function lostConnection(machine: Machine): HandsError {
  return new HandsError(
    "lost",
    `the connection to ${machine.name} was lost`,
    true
  );
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("did not answer in time")),
        milliseconds
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

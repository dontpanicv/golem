import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPublicKey, verify, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ServerWebSocket } from "bun";
import { startTestApp, type TestApp } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";
import { Secrets } from "../platform/secrets.ts";
import { decodeFrame, encodeFrame, sha256Hex } from "./connection.ts";
import { Hands } from "./hands.ts";

let golem: TestApp;
let hands: Hands;
let alice: User;
let eve: User;
let family: string;
let work: string;
let binaries: string;

beforeAll(async () => {
  golem = await startTestApp();
  alice = await person("Alice", "alice@example.com");
  eve = await person("Eve", "eve@example.com");
  family = (await golem.app.workspaces.create(alice, "Family")).id;
  work = (await golem.app.workspaces.create(alice, "Work")).id;
  binaries = await mkdtemp(join(tmpdir(), "golem-hands-"));
  await Bun.write(join(binaries, "hands-darwin-arm64"), "a mac binary");
  hands = new Hands(
    golem.app.database,
    Secrets.forTests(),
    golem.app.workspaces,
    {
      baseUrl: "https://golem.test",
      binaryDirectory: binaries,
      serverPin: async () => "PIN=",
    }
  );
});
afterAll(async () => {
  await hands.close();
  await golem.close();
  await rm(binaries, { recursive: true, force: true });
});

async function person(name: string, email: string): Promise<User> {
  await golem.signIn(name, email);
  const { internalAdapter } = await golem.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(email))!;
  return { id: user.id, name: user.name, email: user.email };
}

function codeOf(command: string): string {
  return command.match(/\/hands\/([a-z2-9]{16}) \| sh$/)![1]!;
}

function pairingRequest(fields: Record<string, unknown> = {}) {
  return {
    name: "mac-mini",
    os: "macos",
    arch: "aarch64",
    version: "0.5.0",
    port: 50_321,
    certSha256: "a".repeat(64),
    addresses: ["192.168.1.40"],
    hostname: "mac-mini.local",
    ...fields,
  };
}

describe("pairing", () => {
  test("a member gets a command that installs hands from Golem, pinned to Golem's key", async () => {
    const { command } = await hands.startPairing(family, alice);
    expect(command).toMatch(
      /^curl -fsSL https:\/\/golem\.test\/hands\/[a-z2-9]{16} \| sh$/
    );
    expect(hands.pairing(family, alice)?.command).toBe(command);

    const script = await hands.installScript(codeOf(command));
    expect(script).toContain(
      `BASE='https://golem.test/hands/${codeOf(command)}'`
    );
    expect(script).toContain("PIN='PIN='");
    expect(script).toContain(`sum='${sha256Hex(Buffer.from("a mac binary"))}'`);
    // Binaries Golem does not have are refused by the script, not downloaded.
    expect(script).toContain("arch=x86_64 sum=''");
    expect(
      await hands.binary(codeOf(command), "hands-darwin-arm64").text()
    ).toBe("a mac binary");
    expect(() => hands.binary(codeOf(command), "../secret.key")).toThrow(
      "Not found"
    );
  });

  test("other people cannot see or pair machines of a workspace", async () => {
    expect(() => hands.machines(family, eve)).toThrow("Not found");
    await expect(hands.startPairing(family, eve)).rejects.toThrow("Not found");
    await expect(hands.installScript("zzzzzz")).rejects.toThrow("Not found");
  });

  test("wrong codes do not end a running pairing", async () => {
    const code = codeOf((await hands.startPairing(family, alice)).command);
    for (let index = 0; index < 150; index += 1) {
      await expect(hands.installScript("z".repeat(16))).rejects.toThrow(
        "Not found"
      );
    }
    expect(await hands.installScript(code)).toContain(code);
  });

  test("a machine pairs once with a code and trusts the workspace's key", async () => {
    const code = codeOf((await hands.startPairing(family, alice)).command);
    expect(() =>
      hands.pair(code, pairingRequest({ certSha256: "nope" }))
    ).toThrow("certSha256 is missing or malformed");
    expect(() => hands.pair(code, "not json")).toThrow(
      "is missing or malformed"
    );

    const answer = hands.pair(code, pairingRequest());
    expect(answer.phoneName).toBe("Golem · Family");
    expect(Buffer.from(answer.publicKey, "base64")).toHaveLength(32);
    expect(() => hands.pair(code, pairingRequest())).toThrow("Not found");
    expect(hands.pairing(family, alice)).toBeNull();

    const [machine] = hands.machines(family, alice);
    expect(machine).toMatchObject({
      name: "mac-mini",
      addresses: ["192.168.1.40"],
      certSha256: "a".repeat(64),
      pairedBy: alice.id,
    });
    // Each workspace signs in with a key of its own.
    const other = codeOf((await hands.startPairing(work, alice)).command);
    expect(hands.pair(other, pairingRequest()).publicKey).not.toBe(
      answer.publicKey
    );
  });

  test("a machine paired again replaces itself, and another one with the same name gets a number", async () => {
    let code = codeOf((await hands.startPairing(family, alice)).command);
    hands.pair(code, pairingRequest({ version: "0.6.0" }));
    code = codeOf((await hands.startPairing(family, alice)).command);
    hands.pair(code, pairingRequest({ certSha256: "b".repeat(64) }));
    const machines = hands.machines(family, alice);
    expect(machines.map((machine) => [machine.name, machine.version])).toEqual([
      ["mac-mini", "0.6.0"],
      ["mac-mini-2", "0.5.0"],
    ]);

    hands.removeMachine(family, alice, machines[1]!.id);
    expect(hands.machines(family, alice)).toHaveLength(1);
    // The removed machine stays, hidden; it pairs again under its name.
    expect(
      golem.app.database
        .query(
          "SELECT name, deleted_at IS NOT NULL AS deleted FROM machine WHERE id = ?"
        )
        .get(machines[1]!.id)
    ).toEqual({ name: `mac-mini-2~${machines[1]!.id}`, deleted: 1 });
    code = codeOf((await hands.startPairing(family, alice)).command);
    hands.pair(code, pairingRequest({ certSha256: "b".repeat(64) }));
    expect(
      hands.machines(family, alice).map((machine) => machine.name)
    ).toEqual(["mac-mini", "mac-mini-2"]);
    hands.removeMachine(family, alice, hands.machines(family, alice)[1]!.id);
    expect(() => hands.removeMachine(work, alice, machines[0]!.id)).toThrow(
      "Not found"
    );
  });

  test("a pairing that names Golem's own machine or a link-local address is refused; LAN and VPN ones pair", async () => {
    const code = codeOf((await hands.startPairing(family, alice)).command);
    for (const fields of [
      { addresses: ["127.0.0.1"] },
      { addresses: ["192.168.1.40", "169.254.169.254"] },
      { addresses: ["::ffff:127.0.0.1"] },
      { hostname: "localhost" },
      { hostname: "golem.localhost" },
    ]) {
      expect(() => hands.pair(code, pairingRequest(fields))).toThrow(
        "is missing or malformed"
      );
    }
    hands.pair(
      code,
      pairingRequest({
        certSha256: "c".repeat(64),
        addresses: ["192.168.1.41", "100.101.102.103"],
      })
    );
  });
});

describe("own machines", () => {
  let bob: User;
  let home: string;
  let office: string;

  beforeAll(async () => {
    bob = await person("Bob", "bob@example.com");
    home = (await golem.app.workspaces.create(bob, "Home")).id;
    office = (await golem.app.workspaces.create(bob, "Office")).id;
  });

  async function pairIn(place: string | null, fields: Record<string, unknown>) {
    const code = codeOf((await hands.startPairing(place, bob)).command);
    return hands.pair(code, pairingRequest(fields));
  }

  test("a person's own machine is for their turns in each of their workspaces, and only theirs", async () => {
    const own = await pairIn(null, {
      name: "laptop",
      certSha256: "1".repeat(64),
    });
    expect(own.phoneName).toBe("Golem · Bob");
    const workspaceKey = (
      await pairIn(home, { name: "server", certSha256: "2".repeat(64) })
    ).publicKey;
    expect(own.publicKey).not.toBe(workspaceKey);

    expect(hands.machines(null, bob).map((machine) => machine.name)).toEqual([
      "laptop",
    ]);
    expect(hands.machines(null, eve)).toEqual([]);
    for (const workspaceId of [home, office]) {
      expect(
        hands
          .machinesIn(workspaceId, bob.id)
          .map((machine) => [machine.name, machine.workspaceId])
      ).toEqual(
        workspaceId === home
          ? [
              ["laptop", null],
              ["server", home],
            ]
          : [["laptop", null]]
      );
    }
    // A turn of nobody, or of another person, sees only the workspace's.
    expect(hands.machinesIn(home, null).map((machine) => machine.name)).toEqual(
      ["server"]
    );
    expect(hands.machinesIn(home, alice.id)).toHaveLength(1);
    expect(() => hands.machineNamed(office, null, "laptop")).toThrow(
      "No machines are paired."
    );

    const [laptop] = hands.machines(null, bob);
    expect(() => hands.removeMachine(null, eve, laptop!.id)).toThrow(
      "Not found"
    );
    expect(() => hands.removeMachine(home, bob, laptop!.id)).toThrow(
      "Not found"
    );
    hands.removeMachine(null, bob, laptop!.id);
    expect(hands.machines(null, bob)).toEqual([]);
  });

  test("a machine paired in a workspace and as one's own shows once in that person's turns, as their own", async () => {
    await pairIn(home, { name: "nas", certSha256: "3".repeat(64) });
    await pairIn(null, { name: "nas", certSha256: "3".repeat(64) });
    expect(
      hands
        .machinesIn(home, bob.id)
        .filter((machine) => machine.certSha256 === "3".repeat(64))
        .map((machine) => [machine.name, machine.workspaceId])
    ).toEqual([["nas", null]]);
    expect(hands.machineNamed(home, null, "nas").workspaceId).toBe(home);
  });

  test("another machine does not take a name that a turn sees with it", async () => {
    await pairIn(null, { name: "server", certSha256: "4".repeat(64) });
    await pairIn(office, { name: "laptop", certSha256: "5".repeat(64) });
    await pairIn(null, { name: "laptop", certSha256: "6".repeat(64) });
    expect(
      hands
        .machinesIn(home, bob.id)
        .map((machine) => machine.name)
        .filter(
          (name) => name.startsWith("server") || name.startsWith("laptop")
        )
    ).toEqual(["laptop-2", "server", "server-2"]);
  });
});

test("a frame whose JSON is not an object is a bad frame", () => {
  for (const json of ["null", "[]", "5", '"text"']) {
    const body = Buffer.from(json);
    const frame = new Uint8Array(13 + body.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, 9 + body.length);
    view.setUint8(4, 3);
    view.setUint32(9, body.length);
    frame.set(body, 13);
    expect(() => decodeFrame(frame)).toThrow("bad frame");
  }
  expect(decodeFrame(encodeFrame(2, 1, { ok: true })).json).toEqual({
    ok: true,
  });
});

describe("the hands tools", () => {
  let listener: ReturnType<typeof fakeHands> extends Promise<infer T>
    ? T
    : never;
  let toolsWorkspace: string;

  beforeAll(async () => {
    toolsWorkspace = (await golem.app.workspaces.create(alice, "Tools")).id;
    const code = codeOf(
      (await hands.startPairing(toolsWorkspace, alice)).command
    );
    listener = await fakeHands();
    const { publicKey } = hands.pair(
      code,
      pairingRequest({
        name: "bender",
        port: listener.port,
        certSha256: listener.certSha256,
        hostname: null,
      })
    );
    // Pairing refuses a loopback address, so the test moves the machine to its fake listener afterwards.
    golem.app.database
      .query("UPDATE machine SET addresses = ? WHERE cert_sha256 = ?")
      .run(JSON.stringify(["127.0.0.1"]), listener.certSha256);
    listener.trust(publicKey);
  });
  afterAll(() => listener.stop());

  function tool(name: string) {
    return hands
      .tools(toolsWorkspace, async () => alice.id)
      .find((candidate) => candidate.name === name)!;
  }

  async function run(name: string, args: Record<string, unknown>) {
    const result = await tool(name).execute(
      args as never,
      { taskId: "task-1", conversationId: 1 } as never,
      BACKGROUND_CONTEXT
    );
    return result.output
      ?.map((block) => ("text" in block ? block.text : ""))
      .join("");
  }

  test("hands_exec runs a command as a job on the machine and returns its output", async () => {
    expect(
      await run("hands_exec", {
        machine: "Bender",
        command: "echo hi",
        cwd: "~/src",
      })
    ).toBe("hi\n\n[exited, exit code 0 on bender]");
    expect(listener.jobs).toEqual([
      {
        key: `golem-${toolsWorkspace}-task-1`,
        command: "echo hi",
        cwd: "/home/bender/src",
      },
    ]);
  });

  test("files are written, read, and edited at paths below the home folder", async () => {
    await run("hands_write", {
      machine: "bender",
      path: "notes.txt",
      content: "milk, eggs",
    });
    expect(
      await run("hands_edit", {
        machine: "bender",
        path: "~/notes.txt",
        old_text: "eggs",
        new_text: "bread",
      })
    ).toBe("Edited /home/bender/notes.txt on bender.");
    expect(
      await run("hands_read", {
        machine: "bender",
        path: "/home/bender/notes.txt",
      })
    ).toBe("milk, bread");
  });

  test("a machine's file is copied to a path part by part, and one over the limit is refused before it is read", async () => {
    const megabyte = 1024 * 1024;
    const content = `${"a".repeat(9 * megabyte - 1)}b`;
    await run("hands_write", { machine: "bender", path: "photo.png", content });
    const directory = await mkdtemp(join(tmpdir(), "golem-hands-"));
    const destination = join(directory, "photo.png");
    try {
      listener.reads.length = 0;
      await hands.file(
        toolsWorkspace,
        alice.id,
        "bender",
        "photo.png",
        destination,
        10 * megabyte
      );
      expect(await Bun.file(destination).text()).toBe(content);
      expect(listener.reads).toEqual([8 * megabyte, 8 * megabyte]);

      listener.reads.length = 0;
      await expect(
        hands.file(
          toolsWorkspace,
          alice.id,
          "bender",
          "photo.png",
          destination,
          megabyte
        )
      ).rejects.toThrow("photo.png on bender is over 1 MB");
      expect(listener.reads).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a file of Golem's is written to a machine part by part", async () => {
    const megabyte = 1024 * 1024;
    const content = `${"a".repeat(9 * megabyte - 1)}b`;
    const directory = await mkdtemp(join(tmpdir(), "golem-hands-"));
    const source = join(directory, "scan.pdf");
    await Bun.write(source, content);
    try {
      expect(
        await hands.put(
          toolsWorkspace,
          alice.id,
          "bender",
          source,
          "~/Documents/scan.pdf"
        )
      ).toBe("/home/bender/Documents/scan.pdf");
      expect(
        listener.files.get("/home/bender/Documents/scan.pdf")?.toString()
      ).toBe(content);
      await Bun.write(source, "");
      await hands.put(
        toolsWorkspace,
        alice.id,
        "bender",
        source,
        "Documents/scan.pdf"
      );
      expect(listener.files.get("/home/bender/Documents/scan.pdf")).toEqual(
        Buffer.alloc(0)
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("the system prompt names the machines", async () => {
    expect(
      await hands
        .section(toolsWorkspace, async () => alice.id)
        .render({ conversationId: 1 } as never, BACKGROUND_CONTEXT)
    ).toContain("- bender: macOS aarch64; reachable as 127.0.0.1");
  });

  test("Golem refuses a machine whose certificate is not the pinned one", async () => {
    const [machine] = hands.machinesIn(toolsWorkspace, alice.id);
    await expect(
      hands.connection({
        ...machine!,
        id: "impostor",
        certSha256: "c".repeat(64),
      })
    ).rejects.toThrow("the certificate does not match the pin");
  });

  test("a machine that sends an error frame whose JSON is null loses its connection", async () => {
    const [machine] = hands.machinesIn(toolsWorkspace, alice.id);
    const connection = await hands.connection({
      ...machine!,
      id: "null-error",
    });
    await expect(connection.request("null-error")).rejects.toThrow("was lost");
    expect(connection.closed).toBe(true);
  });

  test("a machine that does not answer hello in time is closed", async () => {
    const [machine] = hands.machinesIn(toolsWorkspace, alice.id);
    listener.hangHello(true);
    try {
      await expect(
        hands.connection({ ...machine!, id: "silent" })
      ).rejects.toThrow("did not answer in time");
    } finally {
      listener.hangHello(false);
    }
  }, 10_000);

  test("a machine refuses a workspace or a person it did not pair with", async () => {
    const [machine] = hands.machinesIn(toolsWorkspace, alice.id);
    await expect(
      hands.connection({ ...machine!, id: "elsewhere", workspaceId: work })
    ).rejects.toThrow("refused this pairing");
    await expect(
      hands.connection({ ...machine!, id: "own", workspaceId: null })
    ).rejects.toThrow("refused this pairing");
  });
});

/**
 * A `hands` listener on 127.0.0.1 with a new self-signed certificate: the handshake of hands/docs/pairing.md
 * §2, and the operations the tools use, over files kept in memory.
 */
async function fakeHands() {
  const directory = await mkdtemp(join(tmpdir(), "golem-fake-hands-"));
  const made = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      "key.pem",
      "-out",
      "cert.pem",
      "-days",
      "1",
      "-subj",
      "/CN=hands",
    ],
    { cwd: directory, stderr: "pipe" }
  );
  if (!made.success) {
    throw new Error(made.stderr.toString());
  }
  const cert = await Bun.file(join(directory, "cert.pem")).text();
  const key = await Bun.file(join(directory, "key.pem")).text();
  await rm(directory, { recursive: true, force: true });
  const trusted: string[] = [];
  const jobs: Record<string, unknown>[] = [];
  const files = new Map<string, Buffer>();
  /** The length that each pread asked for. */
  const reads: number[] = [];
  const certSha256 = sha256Hex(new X509Certificate(cert).raw);
  const nonce = Buffer.alloc(32, 7).toString("base64");

  const results: Record<
    string,
    (
      json: Record<string, unknown>,
      payload: Uint8Array
    ) => [Record<string, unknown>, Uint8Array?]
  > = {
    hello: () => [{ home: "/home/bender", version: "0.5.0" }],
    "job.start": (json) => {
      jobs.push({ key: json.key, command: json.command, cwd: json.cwd });
      return [{ state: "running", created: true }];
    },
    "job.output": () => [{ nextOffset: 3, eof: true }, Buffer.from("hi\n")],
    "job.status": () => [{ state: "exited", exitCode: 0 }],
    write: (json, payload) => {
      const path = json.path as string;
      const before = json.append ? (files.get(path) ?? Buffer.alloc(0)) : null;
      files.set(
        path,
        before ? Buffer.concat([before, payload]) : Buffer.from(payload)
      );
      return [{}];
    },
    open: (json) => {
      handles.set(1, json.path as string);
      return [
        { handle: 1, stat: { size: files.get(json.path as string)?.length } },
      ];
    },
    pread: (json) => {
      reads.push(json.length as number);
      const offset = json.offset as number;
      return [
        {},
        files
          .get(handles.get(json.handle as number)!)!
          .subarray(offset, offset + (json.length as number)),
      ];
    },
    close: () => [{}],
  };
  const handles = new Map<number, string>();
  let silentHello = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch: (request, bun) =>
      bun.upgrade(request) ? undefined : new Response(null, { status: 404 }),
    websocket: {
      open: (socket) => {
        socket.send(JSON.stringify({ type: "hello", name: "bender", nonce }));
      },
      message: (socket: ServerWebSocket<unknown>, message) => {
        if (typeof message === "string") {
          const auth = JSON.parse(message);
          const valid =
            trusted.includes(auth.publicKey) &&
            verify(
              null,
              Buffer.from(`mycroft-auth:${certSha256}:${nonce}`),
              createPublicKey({
                key: Buffer.concat([
                  Buffer.from("302a300506032b6570032100", "hex"),
                  Buffer.from(auth.publicKey, "base64"),
                ]),
                format: "der",
                type: "spki",
              }),
              Buffer.from(auth.signature, "base64")
            );
          socket.send(
            JSON.stringify(
              valid
                ? { type: "ready" }
                : { type: "error", code: "unauthorized" }
            )
          );
          return;
        }
        const frame = decodeFrame(new Uint8Array(message));
        if (frame.json.op === "hello" && silentHello) {
          return;
        }
        if (frame.json.op === "null-error") {
          // An error frame whose JSON is `null`.
          const body = Buffer.from("null");
          const raw = new Uint8Array(13 + body.length);
          const view = new DataView(raw.buffer);
          view.setUint32(0, 9 + body.length);
          view.setUint8(4, 3);
          view.setUint32(5, frame.id);
          view.setUint32(9, body.length);
          raw.set(body, 13);
          socket.send(raw);
          return;
        }
        const answer = results[frame.json.op as string];
        if (frame.type === 1 && answer) {
          const [json, payload] = answer(frame.json, frame.payload);
          socket.send(encodeFrame(2, frame.id, json, payload));
        }
      },
    },
  });
  return {
    port: server.port!,
    certSha256,
    jobs,
    reads,
    files,
    trust: (publicKey: string) => trusted.push(publicKey),
    /** Stops answering `hello`, as a machine that hangs after its handshake. */
    hangHello: (hang: boolean) => {
      silentHello = hang;
    },
    stop: () => server.stop(true),
  };
}

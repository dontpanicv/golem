import type { Database } from "bun:sqlite";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomInt,
  randomUUID,
} from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";
import { connect } from "node:tls";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound } from "../platform/errors.ts";
import type { Requirement } from "../platform/requirements.ts";
import type { Secrets } from "../platform/secrets.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";
import {
  HandsConnection,
  HandsError,
  type Identity,
  type Machine,
} from "./connection.ts";
import { handsSection, handsTools, machineFile } from "./tools.ts";

export type { Machine } from "./connection.ts";

/** A running pairing: the command to paste on the machine, until it pairs or expires. */
export interface Pairing {
  readonly command: string;
  readonly expiresAt: number;
}

export interface HandsOptions {
  /** Golem's public address; machines download hands and pair over it. */
  readonly baseUrl: string;
  /** Where the `hands-<os>-<arch>` binaries are, which Golem serves to machines: `hands/dist`, which
   * `hands/scripts/build-release.sh` builds. */
  readonly binaryDirectory: string;
  /** The pin of Golem's TLS key at `baseUrl`; tests replace it. */
  readonly serverPin?: (baseUrl: string) => Promise<string>;
}

/**
 * Removes machines without removing anything: a removed machine stays, hidden, and its name and certificate get
 * `~<id>`, which no name or SHA-256 has, so the machine can pair again and another machine can take the name.
 */
const RETIRE =
  "UPDATE machine SET deleted_at = ?, name = name || '~' || id, cert_sha256 = cert_sha256 || '~' || id";
/** The install script template, in the hands source that Golem builds (`hands/`). */
const INSTALL_SCRIPT = join(
  import.meta.dir,
  "../../hands/scripts/pair-install.sh"
);
const PAIRING_LIFETIME = 10 * 60 * 1000;
/** Readable and typable: no 0/o or 1/i/l. */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** After this many wrong codes every running pairing ends, so a code cannot be guessed. */
const MAX_WRONG_CODES = 100;
const BINARIES = [
  "darwin-arm64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-x86_64",
] as const;

/** The hands binaries that Golem serves to the machines that pair; Golem checks them before it starts. */
export async function handsRequirements(
  binaryDirectory: string
): Promise<Requirement[]> {
  const missing: string[] = [];
  for (const target of BINARIES) {
    if (!(await Bun.file(join(binaryDirectory, `hands-${target}`)).exists())) {
      missing.push(`hands-${target}`);
    }
  }
  return [
    {
      name: "hands binaries",
      purpose: "pairing machines",
      install: "hands/scripts/build-release.sh",
      problem: missing.length
        ? `${missing.join(", ")} missing in ${binaryDirectory}`
        : null,
    },
  ];
}

interface PendingPairing extends Pairing {
  readonly code: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
}

/**
 * The machines of a workspace: Macs and Linux computers that run the `hands` daemon in `hands/`. Every agent in the
 * workspace can use every machine, whoever it works for. A machine pairs with the command from the workspace settings,
 * and trusts the workspace's own Ed25519 key from then on; Golem connects to it and pins its certificate.
 */
export class Hands {
  private readonly pairings = new Map<string, PendingPairing>();
  private wrongCodes = 0;
  private readonly connections = new Map<string, Promise<HandsConnection>>();
  private readonly serverPin: (baseUrl: string) => Promise<string>;

  constructor(
    private readonly database: Database,
    private readonly secrets: Secrets,
    private readonly workspaces: Workspaces,
    private readonly options: HandsOptions
  ) {
    this.serverPin = options.serverPin ?? serverPin;
  }

  machines(workspaceId: string, user: User): Machine[] {
    this.workspaces.requireMember(workspaceId, user);
    return this.machinesIn(workspaceId);
  }

  /** The machines of a workspace, for its agents. */
  machinesIn(workspaceId: string): Machine[] {
    const rows = this.database
      .query(
        "SELECT id, name, hostname, addresses, port, cert_sha256 AS certSha256, os, arch, version, paired_at AS pairedAt FROM machine WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY name"
      )
      .all(workspaceId) as (Omit<Machine, "addresses"> & {
      addresses: string;
    })[];
    return rows.map((row) => ({
      ...row,
      addresses: JSON.parse(row.addresses),
    }));
  }

  /** The running pairing of a workspace, if any. */
  pairing(workspaceId: string, user: User): Pairing | null {
    this.workspaces.requireMember(workspaceId, user);
    const pairing = this.pairings.get(workspaceId);
    if (!pairing || pairing.expiresAt < Date.now()) {
      return null;
    }
    return { command: pairing.command, expiresAt: pairing.expiresAt };
  }

  /** Starts pairing a machine with the workspace, and ends the pairing it ran before. */
  async startPairing(workspaceId: string, user: User): Promise<Pairing> {
    const workspace = this.workspaces.requireMember(workspaceId, user);
    if (!this.options.baseUrl.startsWith("https://")) {
      throw new HttpError(
        409,
        "Machines pair over HTTPS: set base_url in config/golem.toml to Golem's https:// address"
      );
    }
    // Checked now, so a missing binary shows here and not on the machine.
    await this.checksums();
    const code = Array.from(
      { length: 6 },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    ).join("");
    const pairing: PendingPairing = {
      code,
      workspaceId,
      workspaceName: workspace.name,
      command: `curl -fsSL ${this.base(code)} | sh`,
      expiresAt: Date.now() + PAIRING_LIFETIME,
    };
    this.pairings.set(workspaceId, pairing);
    return { command: pairing.command, expiresAt: pairing.expiresAt };
  }

  removeMachine(workspaceId: string, user: User, machineId: string): void {
    this.workspaces.requireMember(workspaceId, user);
    const { changes } = this.database
      .query(
        `${RETIRE} WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .run(Date.now(), machineId, workspaceId);
    if (changes === 0) {
      throw notFound();
    }
    this.forget(machineId);
  }

  /** The install script for a pairing code, with Golem's address, pin, and the binaries' SHA-256 filled in. */
  async installScript(code: string): Promise<string> {
    this.pendingPairing(code);
    const [template, checksums, pin] = await Promise.all([
      Bun.file(INSTALL_SCRIPT).text(),
      this.checksums(),
      this.serverPin(this.options.baseUrl),
    ]);
    let script = template
      .replace("@BASE@", this.base(code))
      .replace("@PIN@", pin);
    for (const [target, checksum] of Object.entries(checksums)) {
      script = script.replace(`@SHA256_${target.replace("-", "_")}@`, checksum);
    }
    return script;
  }

  /** A `hands-<os>-<arch>` binary, for a running pairing only. */
  binary(code: string, name: string): Bun.BunFile {
    this.pendingPairing(code);
    if (!BINARIES.some((target) => name === `hands-${target}`)) {
      throw notFound();
    }
    return Bun.file(join(this.options.binaryDirectory, name));
  }

  /**
   * The machine's pairing request (hands/docs/pairing.md, `POST /S/pair`): stores the machine in the
   * workspace and answers with the workspace's identity. A code pairs one machine only.
   */
  pair(code: string, body: unknown): { phoneName: string; publicKey: string } {
    const pairing = this.pendingPairing(code);
    const machine = machineOf(body);
    this.pairings.delete(pairing.workspaceId);
    this.database.transaction(() => {
      // The same machine paired again replaces itself.
      this.database
        .query(
          `${RETIRE} WHERE workspace_id = ? AND cert_sha256 = ? AND deleted_at IS NULL`
        )
        .run(Date.now(), pairing.workspaceId, machine.certSha256);
      this.database
        .query(
          "INSERT INTO machine (id, workspace_id, name, hostname, addresses, port, cert_sha256, os, arch, version, paired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          randomUUID(),
          pairing.workspaceId,
          this.freeName(pairing.workspaceId, machine.name),
          machine.hostname,
          JSON.stringify(machine.addresses),
          machine.port,
          machine.certSha256,
          machine.os,
          machine.arch,
          machine.version,
          Date.now()
        );
    })();
    return {
      phoneName: `Golem · ${pairing.workspaceName}`,
      publicKey: this.identity(pairing.workspaceId).publicKey,
    };
  }

  /** Runs `body` on a connection to the machine, and once more on a new connection if the old one was gone. */
  async with<T>(
    workspaceId: string,
    machine: Machine,
    body: (connection: HandsConnection) => Promise<T>
  ): Promise<T> {
    try {
      return await body(await this.connection(workspaceId, machine));
    } catch (error) {
      if (!(error instanceof HandsError && error.connectionLost)) {
        throw error;
      }
      this.forget(machine.id);
      return body(await this.connection(workspaceId, machine));
    }
  }

  /** One live connection per machine, shared by parallel tool calls, and opened again once it closed. */
  async connection(
    workspaceId: string,
    machine: Machine
  ): Promise<HandsConnection> {
    const existing = await this.connections
      .get(machine.id)
      ?.catch(() => undefined);
    if (existing && !existing.closed) {
      return existing;
    }
    const opening = HandsConnection.open(machine, this.identity(workspaceId));
    this.connections.set(machine.id, opening);
    opening.catch(() => {
      if (this.connections.get(machine.id) === opening) {
        this.connections.delete(machine.id);
      }
    });
    return opening;
  }

  /** Copies a file of one of the workspace's machines, by the machine's name, to `destination`; at most `limit` bytes. */
  file(
    workspaceId: string,
    machineName: string,
    path: string,
    destination: string,
    limit: number
  ): Promise<void> {
    return machineFile(
      this,
      workspaceId,
      machineName,
      path,
      destination,
      limit
    );
  }

  /** The agent tools of a workspace's machines. */
  tools(workspaceId: string) {
    return handsTools(this, workspaceId);
  }

  /** The prompt section that names a workspace's machines. */
  section(workspaceId: string) {
    return handsSection(this, workspaceId);
  }

  async close(): Promise<void> {
    for (const id of [...this.connections.keys()]) {
      this.forget(id);
    }
  }

  private forget(machineId: string): void {
    this.connections
      .get(machineId)
      ?.then((connection) => connection.close())
      .catch(() => {
        // It never opened.
      });
    this.connections.delete(machineId);
  }

  /** Each workspace has its own key, so a machine can trust one workspace and not another. */
  private identity(workspaceId: string): Identity {
    const seed = this.secrets.derive(`hands:${workspaceId}`);
    // PKCS#8 for an Ed25519 private key is this fixed prefix and the 32-byte seed.
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        seed,
      ]),
      format: "der",
      type: "pkcs8",
    });
    const spki = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    return {
      privateKey,
      publicKey: spki.subarray(spki.length - 32).toString("base64"),
    };
  }

  private pendingPairing(code: string): PendingPairing {
    const pairing = [...this.pairings.values()].find(
      (candidate) => candidate.code === code
    );
    if (!pairing) {
      this.wrongCodes += 1;
      if (this.wrongCodes >= MAX_WRONG_CODES) {
        this.wrongCodes = 0;
        this.pairings.clear();
      }
      throw notFound();
    }
    if (pairing.expiresAt < Date.now()) {
      throw new HttpError(410, "This pairing expired; add the machine again");
    }
    return pairing;
  }

  private base(code: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}/hands/${code}`;
  }

  private async checksums(): Promise<Record<string, string>> {
    const checksums: Record<string, string> = {};
    for (const target of BINARIES) {
      const file = Bun.file(
        join(this.options.binaryDirectory, `hands-${target}`)
      );
      checksums[target] = (await file.exists())
        ? createHash("sha256")
            .update(await file.bytes())
            .digest("hex")
        : "";
    }
    if (!Object.values(checksums).some(Boolean)) {
      throw new HttpError(
        409,
        "Golem has no hands binaries: build them with hands/scripts/build-release.sh"
      );
    }
    return checksums;
  }

  /** Names are how people and agents tell machines apart: another machine with a taken name gets a number. */
  private freeName(workspaceId: string, name: string): string {
    const taken = new Set(
      this.machinesIn(workspaceId).map((machine) => machine.name.toLowerCase())
    );
    let candidate = name;
    for (let number = 2; taken.has(candidate.toLowerCase()); number += 1) {
      candidate = `${name.replace(/-\d+$/, "")}-${number}`;
    }
    return candidate;
  }
}

/** The pairing request's machine; anything malformed is a 400. */
function machineOf(request: unknown) {
  const body = (
    typeof request === "object" && request !== null ? request : {}
  ) as Record<string, unknown>;
  const text = (key: string, pattern: RegExp) => {
    const value = body[key];
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new HttpError(400, `${key} is missing or malformed`);
    }
    return value;
  };
  const { port, addresses } = body;
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65_535
  ) {
    throw new HttpError(400, "port is missing or malformed");
  }
  if (
    !Array.isArray(addresses) ||
    addresses.some((address) => typeof address !== "string" || !isIP(address))
  ) {
    throw new HttpError(400, "addresses is missing or malformed");
  }
  const hostname =
    body.hostname === undefined || body.hostname === null
      ? null
      : text("hostname", HOSTNAME);
  return {
    name: text("name", /^[\w.-]{1,63}$/),
    os: text("os", /^[a-z]{1,16}$/),
    arch: text("arch", /^[\w]{1,16}$/),
    version: text("version", /^[\w.+-]{1,32}$/),
    certSha256: text("certSha256", /^[0-9a-f]{64}$/),
    port: port as number,
    addresses: addresses as string[],
    hostname,
  };
}

const HOSTNAME = /^(?=.{1,253}$)[a-zA-Z0-9-]{1,63}(\.[a-zA-Z0-9-]{1,63})*$/;

/**
 * `base64(sha256(SubjectPublicKeyInfo))` of the certificate Golem's address answers with: curl's `--pinnedpubkey`
 * format, which the install script and hands check. The chain is verified first, so Golem pins only its own key.
 * shortcut: a certificate renewed with a new key during the 10 minutes of a pairing fails it; add the machine again.
 */
function serverPin(baseUrl: string): Promise<string> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(
      {
        host: url.hostname,
        port: Number(url.port || 443),
        servername: url.hostname,
      },
      () => {
        const spki = socket
          .getPeerX509Certificate()!
          .publicKey.export({ format: "der", type: "spki" });
        socket.destroy();
        resolve(createHash("sha256").update(spki).digest("base64"));
      }
    );
    socket.on("error", reject);
  });
}

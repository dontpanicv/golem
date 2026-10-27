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
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../platform/auth.ts";
import { isLocal } from "../platform/egress.ts";
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
import {
  fileToMachine,
  handsSection,
  handsTools,
  machineFile,
  machineNamed,
} from "./tools.ts";

export type { Machine } from "./connection.ts";

/** A workspace's id, for every member's turns there, or null for a person's own, for their turns in each workspace. */
export type Place = string | null;

/** The person of a conversation's running turn, or null for none. */
export type RequesterOf = (
  conversationId: ConversationId
) => Promise<string | null>;

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

const COLUMNS =
  "SELECT id, workspace_id AS workspaceId, name, hostname, addresses, port, cert_sha256 AS certSha256, os, arch, version, paired_at AS pairedAt, paired_by AS pairedBy FROM machine WHERE deleted_at IS NULL";
/** The machines of a place: a workspace's, or the person's own. */
const IN_PLACE =
  "workspace_id IS $place AND ($place IS NOT NULL OR paired_by = $userId)";
/**
 * Removes machines without removing anything: a removed machine stays, hidden, and its name and certificate get
 * `~<id>`, which no name or SHA-256 has, so the machine can pair again and another machine can take the name.
 */
const RETIRE =
  "UPDATE machine SET deleted_at = $now, name = name || '~' || id, cert_sha256 = cert_sha256 || '~' || id";
/** The install script template, in the hands source that Golem builds (`hands/`). */
const INSTALL_SCRIPT = join(
  import.meta.dir,
  "../../hands/scripts/pair-install.sh"
);
const PAIRING_LIFETIME = 10 * 60 * 1000;
/** Readable and typable: no 0/o or 1/i/l. */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** 16 characters of 31 are 79 bits, so a code cannot be guessed in its 10 minutes. */
const CODE_LENGTH = 16;
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
  readonly key: string;
  readonly user: User;
  readonly place: Place;
  readonly placeName: string;
}

/**
 * Macs and Linux computers that run the `hands` daemon in `hands/`. A person pairs a machine in a workspace, for every
 * agent there whoever it works for, or as their own, for their own turns in each of their workspaces. A machine pairs
 * with the command from the settings, and trusts the Ed25519 key of that place from then on; Golem connects to it and
 * pins its certificate. One machine can pair with several places: it trusts each key.
 */
export class Hands {
  private readonly pairings = new Map<string, PendingPairing>();
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

  machines(place: Place, user: User): Machine[] {
    this.requireAccess(place, user);
    return this.rows(`${COLUMNS} AND ${IN_PLACE} ORDER BY name`, {
      place,
      userId: user.id,
    });
  }

  /**
   * The machines that a turn of `userId` in a workspace uses: the workspace's and the person's own. A machine paired
   * in both places shows once, as the person's own.
   */
  machinesIn(workspaceId: string, userId: string | null): Machine[] {
    const rows = this.rows(
      `${COLUMNS} AND (workspace_id = $workspaceId OR (workspace_id IS NULL AND paired_by = $userId)) ORDER BY workspace_id IS NOT NULL, name`,
      { workspaceId, userId }
    );
    return rows
      .filter(
        (machine, index) =>
          rows.findIndex((other) => other.certSha256 === machine.certSha256) ===
          index
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The running pairing of a place, if any. */
  pairing(place: Place, user: User): Pairing | null {
    this.requireAccess(place, user);
    const pairing = this.pairings.get(pairingKey(place, user));
    if (!pairing || pairing.expiresAt < Date.now()) {
      return null;
    }
    return { command: pairing.command, expiresAt: pairing.expiresAt };
  }

  /** Starts pairing a machine with the place, and ends the pairing it ran before. */
  async startPairing(place: Place, user: User): Promise<Pairing> {
    const placeName = place
      ? this.workspaces.requireMember(place, user).name
      : user.name;
    if (!this.options.baseUrl.startsWith("https://")) {
      throw new HttpError(
        409,
        "Machines pair over HTTPS: set base_url in config/golem.toml to Golem's https:// address"
      );
    }
    // Checked now, so a missing binary shows here and not on the machine.
    await this.checksums();
    const code = Array.from(
      { length: CODE_LENGTH },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    ).join("");
    const pairing: PendingPairing = {
      code,
      key: pairingKey(place, user),
      user,
      place,
      placeName,
      command: `curl -fsSL ${this.base(code)} | sh`,
      expiresAt: Date.now() + PAIRING_LIFETIME,
    };
    this.pairings.set(pairing.key, pairing);
    return { command: pairing.command, expiresAt: pairing.expiresAt };
  }

  removeMachine(place: Place, user: User, machineId: string): void {
    this.requireAccess(place, user);
    const { changes } = this.database
      .query(
        `${RETIRE} WHERE ${IN_PLACE} AND id = $machineId AND deleted_at IS NULL`
      )
      .run({ now: Date.now(), place, userId: user.id, machineId });
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
   * The machine's pairing request (hands/docs/pairing.md, `POST /S/pair`): stores the machine in the place and
   * answers with the place's identity. A code pairs one machine only.
   */
  pair(code: string, body: unknown): { phoneName: string; publicKey: string } {
    const pairing = this.pendingPairing(code);
    const machine = machineOf(body);
    const { place, user } = pairing;
    this.pairings.delete(pairing.key);
    this.database.transaction(() => {
      // The same machine paired again in the same place replaces itself.
      this.database
        .query(
          `${RETIRE} WHERE ${IN_PLACE} AND cert_sha256 = $certSha256 AND deleted_at IS NULL`
        )
        .run({
          now: Date.now(),
          place,
          userId: user.id,
          certSha256: machine.certSha256,
        });
      this.database
        .query(
          "INSERT INTO machine (id, workspace_id, name, hostname, addresses, port, cert_sha256, os, arch, version, paired_at, paired_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          randomUUID(),
          place,
          this.freeName(place, user, machine),
          machine.hostname,
          JSON.stringify(machine.addresses),
          machine.port,
          machine.certSha256,
          machine.os,
          machine.arch,
          machine.version,
          Date.now(),
          user.id
        );
    })();
    return {
      phoneName: `Golem · ${pairing.placeName}`,
      publicKey: this.identity(place, user.id).publicKey,
    };
  }

  /** Runs `body` on a connection to the machine, and once more on a new connection if the old one was gone. */
  async with<T>(
    machine: Machine,
    body: (connection: HandsConnection) => Promise<T>
  ): Promise<T> {
    try {
      return await body(await this.connection(machine));
    } catch (error) {
      if (!(error instanceof HandsError && error.connectionLost)) {
        throw error;
      }
      this.forget(machine.id);
      return body(await this.connection(machine));
    }
  }

  /**
   * One live connection per machine, shared by parallel tool calls, and opened again once it closed. It signs in with
   * the key of the machine's place.
   */
  async connection(machine: Machine): Promise<HandsConnection> {
    const existing = await this.connections
      .get(machine.id)
      ?.catch(() => undefined);
    if (existing && !existing.closed) {
      return existing;
    }
    const opening = HandsConnection.open(
      machine,
      this.identity(machine.workspaceId, machine.pairedBy)
    );
    this.connections.set(machine.id, opening);
    opening.catch(() => {
      if (this.connections.get(machine.id) === opening) {
        this.connections.delete(machine.id);
      }
    });
    return opening;
  }

  /**
   * Copies a file of a machine that a turn of `userId` in a workspace uses, by the machine's name, to `destination`;
   * at most `limit` bytes.
   */
  file(
    workspaceId: string,
    userId: string | null,
    machineName: string,
    path: string,
    destination: string,
    limit: number
  ): Promise<void> {
    return machineFile(
      this.machineNamed(workspaceId, userId, machineName),
      this,
      path,
      destination,
      limit
    );
  }

  /**
   * Writes a file of Golem's to `path` on a machine that a turn of `userId` in a workspace uses, by the machine's name;
   * returns the absolute path.
   */
  put(
    workspaceId: string,
    userId: string | null,
    machineName: string,
    source: string,
    path: string
  ): Promise<string> {
    return fileToMachine(
      this.machineNamed(workspaceId, userId, machineName),
      this,
      source,
      path
    );
  }

  /** The machine that a name means for a turn of `userId` in a workspace, as the hands tools find it; throws for none. */
  machineNamed(
    workspaceId: string,
    userId: string | null,
    name: string
  ): Machine {
    return machineNamed(this.machinesIn(workspaceId, userId), name);
  }

  /** The agent tools of the machines of a workspace's turns. */
  tools(workspaceId: string, requesterOf: RequesterOf) {
    return handsTools(this, workspaceId, requesterOf);
  }

  /** The prompt section that names the machines of a turn. */
  section(workspaceId: string, requesterOf: RequesterOf) {
    return handsSection(this, workspaceId, requesterOf);
  }

  async close(): Promise<void> {
    for (const id of [...this.connections.keys()]) {
      this.forget(id);
    }
  }

  private rows(sql: string, params: Record<string, string | null>): Machine[] {
    const rows = this.database.query(sql).all(params) as (Omit<
      Machine,
      "addresses"
    > & { addresses: string })[];
    return rows.map((row) => ({
      ...row,
      addresses: JSON.parse(row.addresses),
    }));
  }

  /** A workspace's machines are for its members; a person's own only for them. */
  private requireAccess(place: Place, user: User): void {
    if (place !== null) {
      this.workspaces.requireMember(place, user);
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

  /**
   * Each workspace and each person's own machines have a key, so a machine can trust one place and not another.
   * An own machine always has its owner: only machines of a workspace can be from before `paired_by`.
   */
  private identity(place: Place, ownerId: string | null): Identity {
    const seed = this.secrets.derive(
      place ? `hands:${place}` : `hands:user:${ownerId}`
    );
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

  /**
   * Names are how people and agents tell machines apart, so a machine does not take a name that a turn sees with it:
   * of the workspace and its members' own machines, or of the person's own and their workspaces' machines. Another
   * machine with a taken name gets a number; the same machine in another place keeps its name.
   */
  private freeName(
    place: Place,
    user: User,
    machine: { name: string; certSha256: string }
  ): string {
    const [workspaceIds, ownerIds] = place
      ? [
          [place],
          this.workspaces
            .members(place, this.workspaces.agentMember(place))
            .map((member) => member.userId),
        ]
      : [
          this.workspaces.list(user).map((workspace) => workspace.id),
          [user.id],
        ];
    const rows = this.database
      .query(
        "SELECT name FROM machine WHERE deleted_at IS NULL AND cert_sha256 != ? AND (workspace_id IN (SELECT value FROM json_each(?)) OR (workspace_id IS NULL AND paired_by IN (SELECT value FROM json_each(?))))"
      )
      .all(
        machine.certSha256,
        JSON.stringify(workspaceIds),
        JSON.stringify(ownerIds)
      ) as { name: string }[];
    const taken = new Set(rows.map((row) => row.name.toLowerCase()));
    const { name } = machine;
    let candidate = name;
    for (let number = 2; taken.has(candidate.toLowerCase()); number += 1) {
      candidate = `${name.replace(/-\d+$/, "")}-${number}`;
    }
    return candidate;
  }
}

/** One running pairing for each workspace, and one for each person's own machines. */
function pairingKey(place: Place, user: User): string {
  return place ?? `user:${user.id}`;
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
  // Golem connects to these: a machine is on the LAN or a VPN, never Golem's own machine or a link-local address.
  if (
    !Array.isArray(addresses) ||
    addresses.some(
      (address) =>
        typeof address !== "string" || !isIP(address) || isLocal(address)
    )
  ) {
    throw new HttpError(400, "addresses is missing or malformed");
  }
  const hostname =
    body.hostname === undefined || body.hostname === null
      ? null
      : text("hostname", HOSTNAME);
  if (hostname && /(^|\.)localhost$/i.test(hostname)) {
    throw new HttpError(400, "hostname is missing or malformed");
  }
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

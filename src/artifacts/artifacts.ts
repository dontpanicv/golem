import type { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";
import type { User } from "../platform/auth.ts";
import type { Config } from "../platform/config.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
import type { ThreadRef, Workspaces } from "../workspaces/workspaces.ts";
import { artifactTools } from "./tools.ts";

export type Visibility = "public" | "members";

/**
 * A page or small app that an agent made. It belongs to a channel, or to the workspace when `channelId` is null, as the
 * orchestrator's do, and stays when its thread is settled. Its HTML runs in a sandbox and keeps data through `golem`.
 */
export interface Artifact {
  readonly id: string;
  readonly channelId: string | null;
  /** The thread that made it. */
  readonly threadId: string;
  readonly title: string;
  readonly visibility: Visibility;
  /** The link people share: `<share_url>/<id>` when public and Golem has a public host, else `<base_url>/a/<id>`. */
  readonly url: string;
  /** How many people opened it. */
  readonly visitors: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A value an artifact keeps: shared (`visitor` is null), or owned by one visitor. */
export interface ArtifactRecord {
  /** Names the record in the routes that delete it. */
  readonly id: string;
  readonly visitor: string | null;
  readonly name: string | null;
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: number;
}

export interface ArtifactInput {
  readonly title: string;
  readonly html: string;
  readonly visibility?: Visibility;
}

/** Who looks at an artifact: a signed-in person, or a public visitor with the token of their browser. */
export interface Viewer {
  readonly user?: User;
  readonly token?: string;
}

/** What `golem.me` is in an artifact. */
export interface Me {
  readonly id: string;
  readonly name: string | null;
  readonly member: boolean;
}

export type ArtifactWorkspaces = Pick<
  Workspaces,
  "channel" | "channelsIn" | "orchestratorOf" | "requireMember" | "threadsIn"
>;

const MAX_TITLE = 200;
const MAX_HTML = 2_000_000;
const MAX_KEY = 200;
const MAX_VALUE = 64 * 1024;
const MAX_NAME = 100;
const MAX_KEYS_PER_VISITOR = 1000;
const MAX_RECORDS = 20_000;
/** The live visitors of an artifact; more visitors can still look, but they get no row and no name. */
const MAX_VISITORS = 10_000;
/** The size of the values of an artifact, so that its records and `everyone.list` stay small. */
const MAX_BYTES = 10 * 1024 ** 2;
const SHARED = "shared";
/**
 * Artifact names are four different words of these, such as `amber-fox-lake-moss`, so that people know a link when
 * they see it again; there are about 1.6e8 of them, too many to guess. Names of two words from before stay valid.
 */
const WORDS =
  "acorn amber apple autumn beach berry birch bloom blue breeze brook cedar cherry cloud coral creek dawn daisy deer dove dream dusk eagle earth elm fern field finch flame flower forest fox frolic frost garden gold grape green grove harbor hazel hill honey island ivy jade jasmine lake leaf lemon light lily lime maple meadow mint moon moss mountain oak ocean olive orange orchard otter owl peach pearl pine plum pond poppy rabbit rain raven reed river robin rock rose ruby sage sand sea seed shadow shell shore sky snow sparrow spring star stone storm summer sun swan sweet thyme tiger tulip turtle valley violet water wave willow wind winter wolf wood wren yellow".split(
    " "
  );
const VISIBILITIES: readonly Visibility[] = ["public", "members"];

/** The `golem` object that Golem adds to every artifact. Web and iOS both answer its messages. */
const BRIDGE = `(() => {
  const pending = new Map();
  let next = 0;
  const native = window.webkit?.messageHandlers?.golem;
  // On the web, the link's page gives a port only to the first page of the frame.
  const port = native ? null : new Promise((resolve) => addEventListener("message", (event) => {
    const [given] = event.ports;
    if (event.source !== parent || event.data?.golem !== 1 || !given) return;
    given.onmessage = (reply) => receive(reply.data);
    resolve(given);
  }));
  const send = (op, args) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    const message = { golem: 1, id, op, args };
    if (native) native.postMessage(message); else port.then((given) => given.postMessage(message));
  });
  const receive = (data) => {
    const call = data?.golem === 1 && pending.get(data.id);
    if (!call) return;
    pending.delete(data.id);
    if (data.error) call.reject(new Error(data.error)); else call.resolve(data.result);
  };
  window.__golemReceive = receive;
  const scope = (name) => ({
    get: (key) => send("get", { scope: name, key }),
    set: (key, value) => send("set", { scope: name, key, value }),
    delete: (key) => send("delete", { scope: name, key }),
    list: (prefix = "") => send("list", { scope: name, prefix }),
  });
  const golem = {
    me: null,
    mine: scope("mine"),
    shared: scope("shared"),
    everyone: { list: (prefix = "") => send("list", { scope: "everyone", prefix }) },
    setName: async (name) => (golem.me = await send("name", { name })),
  };
  golem.ready = send("me", {}).then((me) => (golem.me = me));
  window.golem = golem;
})();`;

/** CDNs that do not show their request logs to the authors of pages. */
const CDNS =
  "https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com";

/**
 * Sends data only through `golem`: scripts, styles, and fonts come only from `CDNS`, and pictures only from the page.
 * The web also sends it as a header, with the sandbox.
 */
export const CONTENT_POLICY = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' data: blob: ${CDNS}`,
  `style-src 'unsafe-inline' data: ${CDNS} https://fonts.googleapis.com`,
  "img-src data: blob:",
  `font-src data: ${CDNS} https://fonts.gstatic.com`,
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

interface ArtifactRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string | null;
  readonly threadId: string;
  readonly title: string;
  readonly visibility: Visibility;
  readonly visitors: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const ARTIFACT_COLUMNS =
  "id, workspace_id AS workspaceId, channel_id AS channelId, thread_id AS threadId, title, visibility, created_at AS createdAt, updated_at AS updatedAt, (SELECT count(*) FROM artifact_visitor v WHERE v.artifact_id = artifact.id AND v.deleted_at IS NULL) AS visitors";

/**
 * The artifacts of every channel, and the runtime their pages call. A visitor writes only their own records; members
 * and agents also write the shared ones. Everyone who may open an artifact may read all of its records.
 */
export class Artifacts {
  constructor(
    private readonly database: Database,
    private readonly workspaces: ArtifactWorkspaces,
    private readonly addresses: Pick<Config, "baseUrl" | "shareUrl">,
    /** Tells search that an artifact of the workspace changed. */
    private readonly changed: (workspaceId: string) => void
  ) {}

  /** The agent tools of a workspace. */
  tools(workspaceId: string) {
    return artifactTools(this, this.workspaces, workspaceId);
  }

  /**
   * Makes an artifact in a thread, for a channel of its workspace or, for a null `channelId`, for the workspace. The
   * same `requestKey` again returns the artifact it made before.
   */
  create(
    thread: ThreadRef,
    channelId: string | null,
    input: ArtifactInput & { readonly requestKey: string }
  ): Artifact {
    const title = checkedTitle(input.title);
    const html = checkedHtml(input.html);
    const now = Date.now();
    const made = this.database
      .query(`SELECT ${ARTIFACT_COLUMNS} FROM artifact WHERE request_key = ?`)
      .get(input.requestKey) as ArtifactRow | null;
    if (made) {
      return this.artifact(made);
    }
    this.database
      .query(
        "INSERT INTO artifact (id, workspace_id, channel_id, thread_id, title, html, visibility, request_key, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'golem', ?, ?)"
      )
      .run(
        this.newName(),
        thread.workspaceId,
        channelId,
        thread.id,
        title,
        html,
        checkedVisibility(input.visibility ?? "members"),
        input.requestKey,
        now,
        now
      );
    const row = this.database
      .query(`SELECT ${ARTIFACT_COLUMNS} FROM artifact WHERE request_key = ?`)
      .get(input.requestKey) as ArtifactRow;
    this.changed(thread.workspaceId);
    return this.artifact(row);
  }

  /** Changes an artifact of a workspace; its data stays. */
  update(
    workspaceId: string,
    id: string,
    changes: Partial<ArtifactInput>
  ): Artifact {
    const row = this.row(id);
    if (row?.workspaceId !== workspaceId) {
      throw notFound();
    }
    this.database
      .query(
        "UPDATE artifact SET title = coalesce(?, title), html = coalesce(?, html), visibility = coalesce(?, visibility), updated_at = ? WHERE id = ?"
      )
      .run(
        changes.title === undefined ? null : checkedTitle(changes.title),
        changes.html === undefined ? null : checkedHtml(changes.html),
        changes.visibility === undefined
          ? null
          : checkedVisibility(changes.visibility),
        Date.now(),
        id
      );
    this.changed(workspaceId);
    return this.artifact(this.row(id)!);
  }

  /** The artifacts of a workspace, newest first. */
  inWorkspace(workspaceId: string): Artifact[] {
    const channels = this.liveChannels(workspaceId);
    return (
      this.database
        .query(
          `SELECT ${ARTIFACT_COLUMNS} FROM artifact WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`
        )
        .all(workspaceId) as ArtifactRow[]
    )
      .filter((row) => row.channelId === null || channels.has(row.channelId))
      .map((row) => this.artifact(row));
  }

  /**
   * The artifacts of a channel of the person's workspace from every thread, settled or not, or the workspace's own for
   * a null `channelId`; newest first.
   */
  inPlace(
    workspaceId: string,
    channelId: string | null,
    user: User
  ): Artifact[] {
    if (channelId === null) {
      this.workspaces.requireMember(workspaceId, user);
    } else {
      this.workspaces.channel(workspaceId, channelId, user);
    }
    return (
      this.database
        .query(
          `SELECT ${ARTIFACT_COLUMNS} FROM artifact WHERE workspace_id = ? AND channel_id IS ? AND deleted_at IS NULL ORDER BY created_at DESC`
        )
        .all(workspaceId, channelId) as ArtifactRow[]
    ).map((row) => this.artifact(row));
  }

  /** An artifact of the person's workspace, to manage it. */
  get(id: string, user: User): Artifact {
    const row = this.row(id);
    if (!row) {
      throw notFound();
    }
    this.workspaces.requireMember(row.workspaceId, user);
    return this.artifact(row);
  }

  /** The HTML an agent wrote, without Golem's additions. */
  html(id: string): string {
    return (
      this.database.query("SELECT html FROM artifact WHERE id = ?").get(id) as {
        html: string;
      }
    ).html;
  }

  setVisibility(id: string, user: User, visibility: unknown): Artifact {
    const artifact = this.get(id, user);
    return this.update(this.row(artifact.id)!.workspaceId, artifact.id, {
      visibility: visibility as Visibility,
    });
  }

  /** Nothing is removed: a deleted artifact stays, hidden, with its data, and its name is never given out again. */
  delete(id: string, user: User): void {
    this.get(id, user);
    const { workspaceId } = this.row(id)!;
    this.database
      .query("UPDATE artifact SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), id);
    this.changed(workspaceId);
  }

  /**
   * An artifact a viewer may open: a public one, or a members one for a member. A members artifact asks a signed-out
   * viewer to sign in, and is not found for others.
   */
  open(id: string, viewer: Viewer): Artifact {
    const row = this.row(id);
    if (!row) {
      throw notFound();
    }
    if (row.visibility === "members") {
      if (!viewer.user) {
        throw new HttpError(401, "Sign in first");
      }
      this.workspaces.requireMember(row.workspaceId, viewer.user);
    }
    return this.artifact(row);
  }

  /**
   * The page to run: the content policy and the `golem` runtime at the start of the page, then the agent's HTML. The
   * parser puts them in the page's head, before any of the agent's HTML can run.
   */
  content(id: string): string {
    const html = this.html(id).replace(/^\s*<!doctype[^>]*>/i, "");
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CONTENT_POLICY}"><script>${BRIDGE}</script>${html}`;
  }

  /** Answers a call of an artifact's `golem` runtime for a viewer who may open it. */
  call(id: string, viewer: Viewer, op: unknown, args: unknown): unknown {
    const artifact = this.open(id, viewer);
    const me = this.visit(artifact.id, viewer);
    const input = (typeof args === "object" && args ? args : {}) as Record<
      string,
      unknown
    >;
    if (op === "me") {
      return me;
    }
    if (op === "name") {
      const name = required(input.name, "Name").slice(0, MAX_NAME);
      this.database
        .query(
          "UPDATE artifact_visitor SET name = ? WHERE artifact_id = ? AND visitor = ?"
        )
        .run(name, artifact.id, me.id);
      return { ...me, name };
    }
    const { scope } = input;
    if (op === "list" && scope === "everyone") {
      return this.records(artifact.id, input.prefix).filter(
        (record) => record.visitor !== null
      );
    }
    if (scope !== "mine" && scope !== SHARED) {
      throw new HttpError(400, "Scope is mine, shared, or everyone");
    }
    const owner = scope === "mine" ? me.id : SHARED;
    if (op === "list") {
      return this.records(artifact.id, input.prefix, owner).map((record) => ({
        key: record.key,
        value: record.value,
        updatedAt: record.updatedAt,
      }));
    }
    const key = checkedKey(input.key);
    if (op === "get") {
      return (
        this.records(artifact.id, key, owner).find(
          (record) => record.key === key
        )?.value ?? null
      );
    }
    if (owner === SHARED && !me.member) {
      throw new HttpError(403, "Only members change shared data");
    }
    if (op === "set") {
      this.write(artifact.id, owner, key, input.value);
      return null;
    }
    if (op === "delete") {
      this.deleteRecord(artifact.id, owner, key);
      return null;
    }
    throw new HttpError(400, "Unknown call");
  }

  /** Every record of an artifact, oldest change first; with `owner`, only that owner's. */
  records(id: string, prefix: unknown = "", owner?: string): ArtifactRecord[] {
    const start = typeof prefix === "string" ? prefix : "";
    const rows = this.database
      .query(
        `SELECT r.scope, v.name, r.key, r.value, r.updated_at AS updatedAt FROM artifact_record r
				LEFT JOIN artifact_visitor v ON v.artifact_id = r.artifact_id AND v.visitor = r.scope
				WHERE r.artifact_id = ? AND r.deleted_at IS NULL AND substr(r.key, 1, length(?)) = ? AND (? IS NULL OR r.scope = ?)
				ORDER BY r.updated_at, r.key`
      )
      .all(id, start, start, owner ?? null, owner ?? null) as {
      scope: string;
      name: string | null;
      key: string;
      value: string;
      updatedAt: number;
    }[];
    return rows.map((row) => ({
      id: [row.scope, row.key]
        .map((part) => Buffer.from(part).toString("base64url"))
        .join("."),
      visitor: row.scope === SHARED ? null : row.scope,
      name: row.name,
      key: row.key,
      value: JSON.parse(row.value),
      updatedAt: row.updatedAt,
    }));
  }

  /** Writes a record; `owner` is a visitor, or `shared`. */
  write(id: string, owner: string, key: string, value: unknown): void {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new HttpError(400, "Give a value");
    }
    if (json.length > MAX_VALUE) {
      throw new HttpError(413, "The value is too large");
    }
    checkedKey(key);
    // Records that `clearData` moved aside have `~` in their scope, and count no more.
    const { found, mine, total, others } = this.database
      .query(
        `SELECT count(*) FILTER (WHERE scope = ?1 AND key = ?2) AS found, count(*) FILTER (WHERE scope = ?1) AS mine,
				count(*) AS total, coalesce(sum(length(value)) FILTER (WHERE NOT (scope = ?1 AND key = ?2)), 0) AS others
				FROM artifact_record WHERE artifact_id = ?3 AND scope NOT LIKE '%~%'`
      )
      .get(owner, key, id) as {
      found: number;
      mine: number;
      total: number;
      others: number;
    };
    if (
      (!found &&
        (total >= MAX_RECORDS ||
          (owner !== SHARED && mine >= MAX_KEYS_PER_VISITOR))) ||
      others + json.length > MAX_BYTES
    ) {
      throw new HttpError(413, "This artifact keeps no more data");
    }
    this.database
      .query(
        "INSERT INTO artifact_record (artifact_id, scope, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (artifact_id, scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, deleted_at = NULL"
      )
      .run(id, owner, key, json, Date.now());
  }

  /**
   * Deletes one record; `owner` is a visitor, or `shared`. Nothing is removed: the record stays, hidden, and still
   * counts toward the limits, so that writing and deleting cannot fill the disk. Writing its key again reuses it.
   */
  deleteRecord(id: string, owner: string, key: string): void {
    this.database
      .query(
        "UPDATE artifact_record SET deleted_at = ? WHERE artifact_id = ? AND scope = ? AND key = ? AND deleted_at IS NULL"
      )
      .run(Date.now(), id, owner, key);
  }

  /** Deletes a record, by its `ArtifactRecord.id`, of an artifact of the person's workspace. */
  deleteRecordFor(id: string, user: User, recordId: string): void {
    this.get(id, user);
    const [owner = "", key = ""] = recordId
      .split(".")
      .map((part) => Buffer.from(part, "base64url").toString());
    this.deleteRecord(id, owner, key);
  }

  /**
   * Deletes every record and visitor of an artifact of the person's workspace. The records move aside, with `~<time>`
   * after their scope, so they stay but no longer count toward the limits.
   */
  clearData(id: string, user: User): void {
    this.get(id, user);
    const now = Date.now();
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE artifact_record SET scope = scope || '~' || ?1, deleted_at = coalesce(deleted_at, ?1) WHERE artifact_id = ?2 AND scope NOT LIKE '%~%'"
        )
        .run(now, id);
      this.database
        .query(
          "UPDATE artifact_visitor SET deleted_at = ? WHERE artifact_id = ? AND deleted_at IS NULL"
        )
        .run(now, id);
    })();
  }

  /** The records of an artifact of the person's workspace. */
  dataFor(id: string, user: User): ArtifactRecord[] {
    return this.records(this.get(id, user).id);
  }

  /**
   * Notes a visit and gives the viewer's identity. A member is their user id and name. Another signed-in person is a
   * hash of the artifact and their user id, so the artifact's author learns neither. A public visitor is the hash of
   * their browser's token, so that the id other visitors see does not let them write as that visitor. Past
   * `MAX_VISITORS`, a new visitor gets no row.
   */
  private visit(id: string, viewer: Viewer): Me {
    let me: Me;
    if (viewer.user) {
      const row = this.row(id)!;
      let member = true;
      try {
        this.workspaces.requireMember(row.workspaceId, viewer.user);
      } catch {
        member = false;
      }
      me = member
        ? { id: viewer.user.id, name: viewer.user.name, member }
        : { id: hash(`${id}:${viewer.user.id}`), name: null, member };
    } else if (viewer.token) {
      me = { id: hash(viewer.token), name: null, member: false };
    } else {
      throw new HttpError(403, "Open the link again");
    }
    const known = this.database
      .query(
        "SELECT 1 FROM artifact_visitor WHERE artifact_id = ? AND visitor = ? AND deleted_at IS NULL"
      )
      .get(id, me.id);
    if (!known) {
      const { visitors } = this.database
        .query(
          "SELECT count(*) AS visitors FROM artifact_visitor WHERE artifact_id = ? AND deleted_at IS NULL"
        )
        .get(id) as { visitors: number };
      if (visitors >= MAX_VISITORS) {
        return me;
      }
    }
    const visitor = this.database
      .query(
        "INSERT INTO artifact_visitor (artifact_id, visitor, name, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (artifact_id, visitor) DO UPDATE SET seen_at = excluded.seen_at, deleted_at = NULL RETURNING name"
      )
      .get(id, me.id, me.name, Date.now()) as { name: string | null };
    return { ...me, name: visitor.name };
  }

  /** Four different words that no artifact had before, so that an old link never opens another artifact. */
  private newName(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const words = new Set(
        Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]!)
      );
      const name = [...words].join("-");
      if (
        words.size === 4 &&
        this.database
          .query("INSERT OR IGNORE INTO artifact_name (id) VALUES (?)")
          .run(name).changes === 1
      ) {
        return name;
      }
    }
    throw new HttpError(503, "Golem has no free artifact names");
  }

  /**
   * A live artifact: not deleted, and not in a deleted channel or workspace. The workspace's own artifacts have no
   * channel; a live workspace keeps one channel at least, and a deleted one has none.
   */
  private row(id: string): ArtifactRow | null {
    const row = this.database
      .query(
        `SELECT ${ARTIFACT_COLUMNS} FROM artifact WHERE id = ? AND deleted_at IS NULL`
      )
      .get(id) as ArtifactRow | null;
    if (!row) {
      return null;
    }
    const channels = this.liveChannels(row.workspaceId);
    return (
      row.channelId === null
        ? channels.size > 0
        : channels.has(row.channelId)
    )
      ? row
      : null;
  }

  private liveChannels(workspaceId: string): Set<string> {
    return new Set(
      this.workspaces.channelsIn(workspaceId).map((channel) => channel.id)
    );
  }

  private artifact(row: ArtifactRow): Artifact {
    const { workspaceId: _, ...artifact } = row;
    const { baseUrl, shareUrl } = this.addresses;
    return {
      ...artifact,
      url:
        row.visibility === "public" && shareUrl
          ? `${shareUrl}/${row.id}`
          : new URL(`/a/${row.id}`, baseUrl).href,
    };
  }
}

function checkedTitle(title: unknown): string {
  const text = required(title, "Title");
  if (text.length > MAX_TITLE) {
    throw new HttpError(400, "The title is too long");
  }
  return text;
}

function checkedHtml(html: unknown): string {
  const text = required(html, "HTML");
  if (text.length > MAX_HTML) {
    throw new HttpError(413, "The HTML is too large");
  }
  return text;
}

function checkedVisibility(visibility: unknown): Visibility {
  if (!VISIBILITIES.includes(visibility as Visibility)) {
    throw new HttpError(400, "Visibility is public or members");
  }
  return visibility as Visibility;
}

function checkedKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY) {
    throw new HttpError(400, `A key is text of 1 to ${MAX_KEY} characters`);
  }
  return key;
}

/** A visitor id that does not show what it comes from. */
function hash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 32);
}

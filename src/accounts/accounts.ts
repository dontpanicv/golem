import type { Database } from "bun:sqlite";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { HttpError, notFound } from "../platform/errors.ts";

/** How long a person has for the Google step of a sign-in. */
const FLOW_LIFETIME = 10 * 60_000;
/** How long the app has to swap a code for its token. */
const CODE_LIFETIME = 60_000;
/** The most sign-ins that wait at one time; a new one pushes out the oldest. */
const MAX_WAITING = 1000;

interface Flow {
  readonly challenge: string;
  readonly startedAt: number;
  readonly expiresAt: number;
}

interface Code {
  readonly token: string;
  readonly challenge: string;
  readonly expiresAt: number;
}

/**
 * The Google sign-ins of the iOS app, with PKCE (RFC 7636). A sign-in keeps the app's challenge; its end hands over
 * only the session that its own Google step made, as a code that is good once, for 60 seconds, and only with the
 * verifier of the challenge. So neither a session that the browser had before nor a code that another app catches
 * gives a token. They live in memory: a restart ends the sign-ins that wait.
 */
export class AppSignIns {
  private readonly flows = new Map<string, Flow>();
  private readonly codes = new Map<string, Code>();

  /** Starts a sign-in for a base64url SHA-256 challenge; returns the id that the browser keeps in a cookie. */
  start(challenge: string, now = Date.now()): string {
    if (!/^[\w-]{43}$/.test(challenge)) {
      throw new HttpError(400, "Send the SHA-256 challenge of a verifier");
    }
    const id = randomBytes(32).toString("base64url");
    keep(
      this.flows,
      id,
      {
        challenge,
        startedAt: now,
        expiresAt: now + FLOW_LIFETIME,
      },
      now
    );
    return id;
  }

  /**
   * Ends the sign-in `flowId` with the browser's session, which must be one that its Google step made. Returns the
   * one-time code; throws for any other sign-in or session.
   */
  finish(
    flowId: string | undefined,
    session: { readonly token: string; readonly createdAt: Date } | null,
    now = Date.now()
  ): string {
    const flow = flowId ? this.flows.get(flowId) : undefined;
    if (flowId) {
      this.flows.delete(flowId);
    }
    if (
      !(flow && session && flow.expiresAt > now) ||
      session.createdAt.getTime() < flow.startedAt
    ) {
      throw new HttpError(400, "Sign in again");
    }
    const code = randomBytes(32).toString("base64url");
    keep(
      this.codes,
      code,
      {
        token: session.token,
        challenge: flow.challenge,
        expiresAt: now + CODE_LIFETIME,
      },
      now
    );
    return code;
  }

  /** Swaps a code for its session token, once, with the verifier of the sign-in's challenge. */
  token(code: unknown, verifier: unknown, now = Date.now()): string {
    const found = typeof code === "string" ? this.codes.get(code) : undefined;
    if (found) {
      this.codes.delete(code as string);
    }
    if (
      !(
        found &&
        found.expiresAt > now &&
        typeof verifier === "string" &&
        same(
          createHash("sha256").update(verifier).digest("base64url"),
          found.challenge
        )
      )
    ) {
      throw new HttpError(400, "Sign in again");
    }
    return found.token;
  }
}

/** The largest profile picture; the apps send a small square. */
const MAX_PICTURE = 1024 ** 2;

export interface ProfilePicture {
  readonly userId: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

/**
 * The pictures people upload for their profile. Each upload is a new row with a new id, so a picture's address never
 * changes and browsers keep it; a new upload or a removal marks the old one deleted.
 */
export class ProfilePictures {
  constructor(private readonly database: Database) {}

  /** Makes `file` the person's picture, if it is a JPEG, PNG, or WebP; returns its id. */
  async set(userId: string, file: File | undefined): Promise<string> {
    const data = new Uint8Array((await file?.arrayBuffer()) ?? []);
    const contentType = pictureType(data);
    if (!contentType) {
      throw new HttpError(400, "Send a JPEG, PNG, or WebP picture");
    }
    if (data.length > MAX_PICTURE) {
      throw new HttpError(413, "The picture is larger than 1 MB");
    }
    const id = randomUUID();
    const now = Date.now();
    this.database.transaction(() => {
      this.remove(userId, now);
      this.database
        .query(
          "INSERT INTO profile_picture (id, user_id, content_type, data, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(id, userId, contentType, data, now);
    })();
    return id;
  }

  remove(userId: string, now = Date.now()): void {
    this.database
      .query(
        "UPDATE profile_picture SET deleted_at = ? WHERE user_id = ? AND deleted_at IS NULL"
      )
      .run(now, userId);
  }

  /** The id of each person's picture, for the people who have one. */
  ids(userIds: readonly string[]): Map<string, string> {
    const rows = this.database
      .query(
        `SELECT user_id AS userId, id FROM profile_picture WHERE deleted_at IS NULL AND user_id IN (${userIds.map(() => "?").join(", ")})`
      )
      .all(...userIds) as { userId: string; id: string }[];
    return new Map(rows.map((row) => [row.userId, row.id]));
  }

  /** A picture that is not deleted; throws not found for any other id. */
  get(id: string): ProfilePicture {
    const picture = this.database
      .query(
        "SELECT user_id AS userId, content_type AS contentType, data FROM profile_picture WHERE id = ? AND deleted_at IS NULL"
      )
      .get(id) as ProfilePicture | null;
    if (!picture) {
      throw notFound();
    }
    return picture;
  }
}

/** The type of a JPEG, PNG, or WebP picture from its first bytes, so nothing else is ever served as a picture. */
function pictureType(data: Uint8Array): string | undefined {
  const starts = (bytes: number[], at = 0) =>
    bytes.every((byte, index) => data[at + index] === byte);
  if (starts([0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return undefined;
}

/** Adds an entry, after it drops the expired ones and, at the limit, the oldest. */
function keep<T extends { readonly expiresAt: number }>(
  entries: Map<string, T>,
  key: string,
  value: T,
  now: number
): void {
  for (const [id, entry] of entries) {
    if (entry.expiresAt <= now) {
      entries.delete(id);
    }
  }
  while (entries.size >= MAX_WAITING) {
    entries.delete(entries.keys().next().value!);
  }
  entries.set(key, value);
}

function same(a: string, b: string): boolean {
  return (
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}

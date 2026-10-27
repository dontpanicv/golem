import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "../platform/errors.ts";

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

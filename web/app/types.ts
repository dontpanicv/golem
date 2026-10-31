// The types of the JSON API, as docs/api.md writes them. test/web-types.test.ts checks that the server's types fit them.

export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** The person's role: `owner` can rename and delete the workspace, and add members. */
  readonly role: string;
}

/** Times are Unix milliseconds. */
export interface ThreadSummary {
  readonly id: string;
  readonly channelId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly settledAt: number | null;
}

export interface Channel {
  readonly id: string;
  readonly name: string;
  /** The person a private channel belongs to; null for one every member sees. */
  readonly ownerId: string | null;
  readonly summary: string | null;
  readonly icon: string | null;
  /** Newest first. */
  readonly threads: readonly ThreadSummary[];
}

export interface Facts {
  readonly text: string;
}

export interface Member {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
}

export interface Brief {
  /** Markdown with thread links, `[title](thread:<threadId>)`. */
  readonly text: string;
  readonly updatedAt: number;
}

export interface FileRef {
  readonly id: string;
  readonly name: string;
}

export interface Message {
  readonly id: string;
  /** Null for the agent. */
  readonly authorId: string | null;
  readonly author: string;
  readonly agent: boolean;
  readonly text: string;
  readonly time: number;
  /** The agent's answer failed; `text` is the error. */
  readonly failed: boolean;
  /** The agent is still writing this message. */
  readonly streaming: boolean;
  readonly files: readonly FileRef[];
  /** What the agent did before this answer; null for people and for an answer without work. */
  readonly work: Work | null;
}

export interface Work {
  readonly startedAt: number;
  /** Null while the agent works. */
  readonly endedAt: number | null;
  readonly stopped: boolean;
  readonly steps: readonly Step[];
}

/** A thought, words between tool calls, or a tool call. */
export interface Step {
  readonly kind: "thinking" | "text" | "tool";
  readonly text: string;
  readonly tool: string | null;
  readonly input: string | null;
  readonly output: string | null;
  readonly running: boolean;
  readonly failed: boolean;
}

export interface SavedFile {
  readonly id: string;
  readonly name: string;
  /** Bytes. */
  readonly size: number;
  readonly time: number;
}

export interface ThreadState {
  readonly thread: ThreadSummary;
  readonly messages: readonly Message[];
  readonly running: boolean;
  readonly approvals: readonly Approval[];
}

/** An action that waits for one person, or for any member when `approverId` is null. */
export interface Approval {
  readonly id: string;
  readonly tool: string;
  readonly text: string;
  readonly approverId: string | null;
  /** Whether the person may also allow the rest of the turn on its machine. */
  readonly allowsTurn: boolean;
  readonly expiresAt: number;
}

export type SearchKind = "thread" | "artifact" | "note" | "file" | "capture";
export type Modality = "text" | "image" | "audio" | "none";

export interface SearchResult {
  /** `thread:<id>`, `artifact:<id>`, or a path under the workspace folder. */
  readonly uri: string;
  readonly kind: SearchKind;
  readonly modality: Modality;
  readonly title: string;
  readonly threadId: string | null;
  readonly channelId: string | null;
  readonly snippet: string;
  readonly score: number;
  readonly updatedAt: number;
}

/** A query that the person searched, and when they last searched it. */
export interface RecentSearch {
  readonly query: string;
  readonly searchedAt: number;
}

export interface SearchResponse {
  readonly results: readonly SearchResult[];
  /** False while the search model starts: results then match words only. */
  readonly semantic: boolean;
}

export interface Credential {
  readonly id: string;
  readonly label: string;
  /** The person who connected it; only they share or delete it. */
  readonly ownerId: string;
  readonly ownerName: string;
  /** Whether every member's turns use it; else only its owner's. */
  readonly shared: boolean;
  readonly createdAt: number;
}

export interface Integration {
  readonly id: string;
  readonly name: string;
  /** With a secret, by signing in on its page, or by linking a phone number with a code. */
  readonly connect: "secret" | "sign-in" | "phone";
  /** The name of the secret, for `connect: "secret"`. */
  readonly secretLabel: string | null;
  /** Whether the person names a credential; else Golem names it from the secret. */
  readonly labeled: boolean;
  /** Whether the secret also needs the address of the person's own server. */
  readonly address: boolean;
  /** The name of the account that the secret also needs, such as `Email`, which names the credential. */
  readonly username: string | null;
  /** The steps that set it up, in Markdown; empty when Connect is all. */
  readonly guide: readonly string[];
  /** Golem's own OAuth client, which the server's owner sets: its ID, and whether this person may set it. */
  readonly client: {
    readonly clientId: string | null;
    readonly changeable: boolean;
  } | null;
  readonly credentials: readonly Credential[];
}

export type RoutineOutcome = "running" | "quiet" | "posted" | "failed";

export interface RoutineRun {
  readonly id: string;
  readonly routineId: string;
  readonly routineName: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly outcome: RoutineOutcome;
  readonly error: string | null;
}

export interface Routine {
  readonly id: string;
  readonly channelId: string;
  readonly name: string;
  readonly enabled: boolean;
  /** Null while paused. */
  readonly nextRunAt: number | null;
  readonly threadId: string | null;
}

export interface Artifact {
  /** Four words, such as "amber-fox-lake-moss"; names from before have two. */
  readonly id: string;
  readonly channelId: string | null;
  readonly threadId: string;
  readonly title: string;
  readonly visibility: "public" | "members";
  readonly url: string;
  readonly visitors: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ArtifactRecord {
  readonly id: string;
  /** Null for a shared record. */
  readonly visitor: string | null;
  readonly name: string | null;
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: number;
}

export interface Machine {
  readonly id: string;
  readonly name: string;
  readonly os: string;
  readonly arch: string;
  readonly version: string;
  /** The person who paired it; only they share or remove it. */
  readonly pairedBy: string;
  readonly pairedByName: string;
  /** Whether every member's turns use it; else only its person's. */
  readonly shared: boolean;
}

export interface Pairing {
  readonly command: string;
  readonly expiresAt: number;
}

export type Effort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface LlmStatus {
  readonly connected: boolean;
  /** Whether the person is the server's owner, who alone changes the login, the model, and the effort. */
  readonly owner: boolean;
  readonly provider: string;
  readonly model: string;
  readonly effort: Effort;
  readonly models: readonly {
    readonly id: string;
    readonly name: string;
    readonly efforts: readonly Effort[];
  }[];
  readonly login: {
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresAt: number;
  } | null;
  readonly error: string | null;
}

/** Something that needs the person: it opens its thread, or its channel without one. */
export interface Notification {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId: string | null;
  readonly title: string;
  readonly text: string;
  readonly createdAt: number;
  readonly readAt: number | null;
}

export interface Inbox {
  readonly notifications: readonly Notification[];
  readonly unread: number;
  readonly badge: number;
}

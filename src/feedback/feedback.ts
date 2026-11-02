import type { Database } from "bun:sqlite";
import type { User } from "../platform/auth.ts";
import { HttpError, required } from "../platform/errors.ts";
import type { Threads } from "../threads/threads.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";
import { feedbackTools } from "./tools.ts";

export const FEEDBACK_KINDS = ["error", "missing", "better"] as const;

/** What an agent reports about Golem itself while it works, for the server's owner to make Golem better. */
export interface Feedback {
  readonly id: string;
  /** `error`: a tool failed or answered wrong; `missing`: no tool can do it; `better`: an easier or faster way. */
  readonly kind: (typeof FEEDBACK_KINDS)[number];
  /** The tool it is about, if any. */
  readonly tool: string | null;
  readonly summary: string;
  readonly detail: string;
  /** The thread of the turn, only when the reader sees it. */
  readonly threadId: string | null;
  readonly createdAt: number;
}

export interface FeedbackInput {
  readonly id: string;
  readonly threadId: string | null;
  readonly personId: string | null;
  readonly kind: string;
  readonly tool?: string;
  readonly summary: string;
  readonly detail: string;
}

type FeedbackWorkspaces = Pick<
  Workspaces,
  "requireMember" | "threadOf" | "threadsIn"
>;
type FeedbackThreads = Pick<Threads, "requester">;

const COLUMNS =
  "id, kind, tool, summary, detail, thread_id AS threadId, created_at AS createdAt";

/**
 * The reports that agents write about Golem: failed tools, missing tools, and better ways. Only the server's owner
 * reads them, also those from other people's private turns, but without a link to a thread they do not see.
 */
export class FeedbackReports {
  constructor(
    private readonly database: Database,
    private readonly workspaces: FeedbackWorkspaces,
    private readonly threads: FeedbackThreads,
    /** The email of the server's owner, lowercase. */
    private readonly owner: string | null
  ) {}

  tools(workspaceId: string) {
    return feedbackTools(this, this.workspaces, this.threads, workspaceId);
  }

  report(workspaceId: string, input: FeedbackInput): void {
    if (!FEEDBACK_KINDS.includes(input.kind as Feedback["kind"])) {
      throw new Error(`Give kind as one of: ${FEEDBACK_KINDS.join(", ")}.`);
    }
    this.database
      .query(
        "INSERT OR IGNORE INTO feedback (id, workspace_id, thread_id, person_id, kind, tool, summary, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.id,
        workspaceId,
        input.threadId,
        input.personId,
        input.kind,
        input.tool?.trim() || null,
        required(input.summary, "Summary"),
        required(input.detail, "Detail"),
        Date.now()
      );
  }

  /** The reports of a workspace that nobody dismissed, newest first; `403` for everyone but the server's owner. */
  list(workspaceId: string, user: User): Feedback[] {
    this.requireOwner(workspaceId, user);
    const seen = new Set(
      this.workspaces.threadsIn(workspaceId, user.id).map(({ id }) => id)
    );
    return (
      this.database
        .query(
          `SELECT ${COLUMNS} FROM feedback WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`
        )
        .all(workspaceId) as Feedback[]
    ).map((feedback) => ({
      ...feedback,
      threadId:
        feedback.threadId && seen.has(feedback.threadId)
          ? feedback.threadId
          : null,
    }));
  }

  dismiss(workspaceId: string, user: User, id: string): void {
    this.requireOwner(workspaceId, user);
    const { changes } = this.database
      .query(
        "UPDATE feedback SET deleted_at = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL"
      )
      .run(Date.now(), id, workspaceId);
    if (changes === 0) {
      throw new HttpError(404, "Not found");
    }
  }

  private requireOwner(workspaceId: string, user: User): void {
    this.workspaces.requireMember(workspaceId, user);
    if (user.email.toLowerCase() !== this.owner) {
      throw new HttpError(403, "Only the server's owner reads feedback");
    }
  }
}

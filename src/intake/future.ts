import type { Database } from "bun:sqlite";
import type { Assessment } from "./assess.ts";

/** Stores the stated time separately from the next internal review. */
export function saveCheck(
  database: Database,
  check: Assessment["checks"][number],
  scope: {
    id: string;
    workspaceId: string;
    ownerId: string;
    chatId: string | null;
    checkAt: number;
    now: number;
  }
): void {
  const prior = database
    .query(
      "SELECT source_ids,check_at,next_review_at,explicit_time FROM intake_check WHERE id=? AND workspace_id=? AND owner_id=?"
    )
    .get(scope.id, scope.workspaceId, scope.ownerId) as {
    source_ids: string;
    check_at: number;
    next_review_at: number;
    explicit_time: number;
  } | null;
  const sources = [
    ...new Set([
      ...(prior ? (JSON.parse(prior.source_ids) as string[]) : []),
      check.evidence,
    ]),
  ];
  const statedTime = check.at !== null || check.afterDays !== null;
  // A context update without a new stated time must not shorten or reset the original response period.
  const preserveTime = prior !== null && !statedTime;
  const explicitTime = statedTime ? 1 : 0;
  database
    .query(
      "INSERT INTO intake_check(id,workspace_id,owner_id,chat_id,text,source_ids,explicit_time,check_at,next_review_at,revised_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,source_ids=excluded.source_ids,explicit_time=excluded.explicit_time,check_at=excluded.check_at,next_review_at=excluded.next_review_at,chat_id=coalesce(excluded.chat_id,intake_check.chat_id),revised_at=excluded.revised_at,state='open',notified_at=CASE WHEN check_at != excluded.check_at THEN NULL ELSE notified_at END WHERE intake_check.state != 'stopped'"
    )
    .run(
      scope.id,
      scope.workspaceId,
      scope.ownerId,
      scope.chatId,
      check.text,
      JSON.stringify(sources),
      preserveTime ? prior.explicit_time : explicitTime,
      preserveTime ? prior.check_at : scope.checkAt,
      preserveTime ? prior.next_review_at : scope.checkAt,
      scope.now
    );
}

import type { Database } from "bun:sqlite";
import { randomUUIDv5 } from "bun";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound } from "../platform/errors.ts";
import type { Assessment } from "./assess.ts";
import type { Delivery, IntakeThreads, IntakeWorkspaces } from "./intake.ts";

/** Creates a destination only after its queued review has passed the final assessment. */
export class IntakeDestinations {
  constructor(
    private readonly database: Database,
    private readonly workspaces: IntakeWorkspaces,
    private readonly threads: Pick<IntakeThreads, "startAgentThread">
  ) {}

  async bind(
    delivery: Delivery,
    owner: User,
    decision: Assessment,
    now: number
  ): Promise<void> {
    const workspaceId = delivery.workspace_id;
    this.workspaces.requireMember(workspaceId, owner);
    const available = this.workspaces.threadsIn(workspaceId, owner.id);
    const requestId = `intake:subject:${delivery.id}`;
    let thread = available.find(
      (candidate) =>
        candidate.id === (decision.threadId ?? randomUUIDv5(requestId, "url"))
    );
    if (!thread && decision.startThread) {
      const channel = this.channel(workspaceId, owner, decision);
      thread =
        available.find(
          (candidate) =>
            candidate.channelId === channel.id &&
            candidate.title === decision.title
        ) ??
        (await this.threads.startAgentThread(
          workspaceId,
          channel.id,
          decision.title,
          { id: requestId, personId: owner.id }
        ));
    }
    if (!thread) {
      throw notFound();
    }
    const target = thread;
    const evidence = [
      ...new Set([
        ...(JSON.parse(delivery.evidence_ids) as string[]),
        ...decision.evidence,
      ]),
    ];
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE intake_delivery SET thread_id=?,body=?,attention=?,evidence_ids=?,notification=?,subject=?,cancelled_at=NULL WHERE id=? AND workspace_id=? AND owner_id=?"
        )
        .run(
          target.id,
          delivery.body,
          decision.attention,
          JSON.stringify(evidence),
          delivery.notification,
          JSON.stringify(decision),
          delivery.id,
          workspaceId,
          owner.id
        );
      this.database
        .query(
          "UPDATE intake_check SET thread_id=? WHERE workspace_id=? AND owner_id=? AND thread_id IS NULL AND id IN (SELECT value FROM json_each(?))"
        )
        .run(target.id, workspaceId, owner.id, delivery.check_ids);
      this.database
        .query(
          "UPDATE intake_item SET thread_id=coalesce(thread_id,?) WHERE workspace_id=? AND owner_id=? AND id IN (SELECT value FROM json_each(?))"
        )
        .run(target.id, workspaceId, owner.id, JSON.stringify(evidence));
      if (decision.summary) {
        this.database
          .query(
            "INSERT INTO intake_context VALUES(?,?,?,?,?,?) ON CONFLICT DO UPDATE SET summary=excluded.summary,source_ids=excluded.source_ids,updated_at=excluded.updated_at"
          )
          .run(
            workspaceId,
            owner.id,
            target.id,
            decision.summary,
            JSON.stringify(evidence),
            now
          );
      }
    })();
    delivery.thread_id = target.id;
    delivery.attention = decision.attention;
    delivery.evidence_ids = JSON.stringify(evidence);
    delivery.cancelled_at = null;
  }

  private channel(workspaceId: string, owner: User, decision: Assessment) {
    this.workspaces.requireMember(workspaceId, owner);
    if (decision.channelId) {
      // A new matter of the person's sources starts only in their own private channel.
      const existing = this.workspaces
        .channelsIn(workspaceId, owner.id)
        .find(
          (channel) =>
            channel.id === decision.channelId && channel.ownerId === owner.id
        );
      if (!existing) {
        throw notFound();
      }
      return existing;
    }
    const proposed = decision.newChannel!;
    for (let suffix = 1; ; suffix += 1) {
      const name = suffix === 1 ? proposed.name : `${proposed.name}-${suffix}`;
      const existing = this.workspaces
        .channelsIn(workspaceId, owner.id)
        .find((channel) => channel.name === name);
      if (existing?.ownerId === owner.id) {
        return existing;
      }
      if (existing) {
        continue;
      }
      try {
        const channel = this.workspaces.addChannel(
          workspaceId,
          name,
          "golem",
          owner.id
        );
        this.workspaces.setChannelSummary(
          workspaceId,
          channel.id,
          proposed.summary
        );
        return channel;
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 409)) {
          throw error;
        }
      }
    }
  }
}

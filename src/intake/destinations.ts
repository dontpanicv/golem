import type { Database } from "bun:sqlite";
import { randomUUIDv5 } from "bun";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound } from "../platform/errors.ts";
import type { Assessment } from "./assess.ts";
import type { Delivery, IntakeChats, IntakeWorkspaces } from "./intake.ts";

/** Creates a destination only after its queued review has passed the final assessment. */
export class IntakeDestinations {
  constructor(
    private readonly database: Database,
    private readonly workspaces: IntakeWorkspaces,
    private readonly chats: Pick<IntakeChats, "startAgentChat">
  ) {}

  async bind(
    delivery: Delivery,
    owner: User,
    decision: Assessment,
    now: number
  ): Promise<void> {
    const workspaceId = delivery.workspace_id;
    this.workspaces.requireMember(workspaceId, owner);
    const available = this.workspaces.chatsIn(workspaceId, owner.id);
    const requestId = `intake:subject:${delivery.id}`;
    let chat = available.find(
      (candidate) =>
        candidate.id === (decision.chatId ?? randomUUIDv5(requestId, "url"))
    );
    if (!chat && decision.startChat) {
      const topic = this.topic(workspaceId, owner, decision);
      chat =
        available.find(
          (candidate) =>
            candidate.topicId === topic.id && candidate.title === decision.title
        ) ??
        (await this.chats.startAgentChat(
          workspaceId,
          topic.id,
          decision.title,
          { id: requestId, personId: owner.id }
        ));
    }
    if (!chat) {
      throw notFound();
    }
    const target = chat;
    const evidence = [
      ...new Set([
        ...(JSON.parse(delivery.evidence_ids) as string[]),
        ...decision.evidence,
      ]),
    ];
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE intake_delivery SET chat_id=?,body=?,attention=?,evidence_ids=?,notification=?,subject=?,cancelled_at=NULL WHERE id=? AND workspace_id=? AND owner_id=?"
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
          "UPDATE intake_check SET chat_id=? WHERE workspace_id=? AND owner_id=? AND chat_id IS NULL AND id IN (SELECT value FROM json_each(?))"
        )
        .run(target.id, workspaceId, owner.id, delivery.check_ids);
      this.database
        .query(
          "UPDATE intake_item SET chat_id=coalesce(chat_id,?) WHERE workspace_id=? AND owner_id=? AND id IN (SELECT value FROM json_each(?))"
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
    delivery.chat_id = target.id;
    delivery.attention = decision.attention;
    delivery.evidence_ids = JSON.stringify(evidence);
    delivery.cancelled_at = null;
  }

  private topic(workspaceId: string, owner: User, decision: Assessment) {
    this.workspaces.requireMember(workspaceId, owner);
    if (decision.topicId) {
      // A new matter of the person's sources starts only in their own private topic.
      const existing = this.workspaces
        .topicsIn(workspaceId, owner.id)
        .find(
          (topic) => topic.id === decision.topicId && topic.ownerId === owner.id
        );
      if (!existing) {
        throw notFound();
      }
      return existing;
    }
    const proposed = decision.newTopic!;
    for (let suffix = 1; ; suffix += 1) {
      const name = suffix === 1 ? proposed.name : `${proposed.name}-${suffix}`;
      const existing = this.workspaces
        .topicsIn(workspaceId, owner.id)
        .find((topic) => topic.name === name);
      if (existing?.ownerId === owner.id) {
        return existing;
      }
      if (existing) {
        continue;
      }
      try {
        const topic = this.workspaces.addTopic(
          workspaceId,
          name,
          "golem",
          owner.id
        );
        this.workspaces.setTopicSummary(
          workspaceId,
          topic.id,
          proposed.summary
        );
        return topic;
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 409)) {
          throw error;
        }
      }
    }
  }
}

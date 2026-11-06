import type { Database } from "bun:sqlite";
import type { WatchedItem } from "../integrations/integrations.ts";
import type { User } from "../platform/auth.ts";
import { notFound } from "../platform/errors.ts";
import type { AssessmentInput, Evidence, FutureCheck } from "./assess.ts";
import type { Audit } from "./audit.ts";
import type {
  IntakeIntegrations,
  IntakeSearch,
  IntakeThreads,
  IntakeWorkspaces,
} from "./intake.ts";

export interface ItemRow {
  id: string;
  credential_id: string;
  workspace_id: string;
  owner_id: string;
  source_id: string;
  version: string;
  payload: string;
  at: number;
  read_at: number | null;
  reading: string | null;
  assessed_at: number | null;
  thread_id: string | null;
  archived_id: string | null;
  superseded_at: number | null;
}
export interface SourceRow {
  credential_id: string;
  workspace_id: string;
  owner_id: string;
  polled_at: number;
  attempted_at: number;
  error: string | null;
  checkpoint: string;
}
interface CheckRow {
  id: string;
  thread_id: string | null;
  text: string;
  source_ids: string;
  explicit_time: number;
  check_at: number;
  next_review_at: number;
  notified_at: number | null;
}
export interface IntakeSourceStatus {
  id: string;
  name: string;
  /** Until when Golem has read the account; null before its first read. */
  readAt: number | null;
  error: string | null;
  kept: number;
}
/** Reads the current private evidence and the Golem context that a person can use. */
export class IntakeRecall {
  constructor(
    private readonly database: Database,
    private readonly workspaces: IntakeWorkspaces,
    private readonly integrations: IntakeIntegrations,
    private readonly threads: Pick<IntakeThreads, "messages">,
    private readonly search: IntakeSearch,
    private readonly audit: Audit
  ) {}

  async context(
    workspaceId: string,
    owner: User,
    evidence: Evidence[],
    checks: FutureCheck[],
    subjectId?: string,
    includeRecent = false
  ): Promise<AssessmentInput["threads"]> {
    this.workspaces.requireMember(workspaceId, owner);
    const available = new Map(
      this.workspaces
        .threadsIn(workspaceId, owner.id)
        .map((thread) => [thread.id, thread])
    );
    const ids = new Set<string>();
    if (includeRecent && !subjectId) {
      const recent = [...available.values()]
        .toSorted((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 12);
      for (const thread of recent) {
        ids.add(thread.id);
      }
    }
    if (subjectId) {
      if (!available.has(subjectId)) {
        throw notFound();
      }
      ids.add(subjectId);
    } else {
      for (const id of await this.candidateIds(
        workspaceId,
        owner,
        evidence,
        checks
      )) {
        ids.add(id);
      }
    }
    const candidates = [...ids]
      .flatMap((id) => (available.has(id) ? [available.get(id)!] : []))
      .slice(0, 24);
    const budget = Math.min(
      2400,
      Math.floor(6000 / Math.max(1, candidates.length))
    );
    const result: AssessmentInput["threads"] = [];
    for (const thread of candidates) {
      const state = await this.threads.messages(thread);
      const known = this.database
        .query(
          "SELECT summary FROM intake_context WHERE workspace_id=? AND owner_id=? AND thread_id=?"
        )
        .get(workspaceId, owner.id, thread.id) as { summary: string } | null;
      const context = [
        "Latest messages first:",
        ...state.messages
          .slice(-4)
          .toReversed()
          .map((message) => `${message.author}: ${message.text.slice(0, 600)}`),
        known ? `Prior source summary: ${known.summary.slice(0, 600)}` : "",
      ]
        .join("\n")
        .slice(0, budget);
      result.push({
        id: thread.id,
        channelId: thread.channelId,
        title: thread.title,
        context,
      });
    }
    return result;
  }

  private async candidateIds(
    workspaceId: string,
    owner: User,
    evidence: Evidence[],
    checks: FutureCheck[]
  ): Promise<Set<string>> {
    return new Set([
      ...evidence.flatMap((item) =>
        item.url?.startsWith("thread:") ? [item.url.slice(7)] : []
      ),
      ...[
        ...this.conversationRows(workspaceId, owner, evidence),
        ...this.matches(workspaceId, owner, evidence),
      ].flatMap((row) => (row.thread_id ? [row.thread_id] : [])),
      ...(await this.searchIds(workspaceId, owner, evidence)),
      ...checks.flatMap((check) => (check.threadId ? [check.threadId] : [])),
    ]);
  }

  private async searchIds(
    workspaceId: string,
    owner: User,
    evidence: Evidence[]
  ): Promise<string[]> {
    const result: string[] = [];
    for (const group of Map.groupBy(
      evidence,
      (item) => item.conversation
    ).values()) {
      const query = group
        .slice(-6)
        .map((item) => item.text.slice(0, 600))
        .join("\n")
        .slice(0, 1800);
      if (!query) {
        continue;
      }
      const found = await this.search.search(
        workspaceId,
        query,
        4,
        owner.id,
        "thread"
      );
      this.audit.record(
        `search:${new Bun.CryptoHasher("sha256").update(query).digest("hex")}`,
        "search.results",
        workspaceId,
        owner.id,
        { query, results: found.results }
      );
      result.push(
        ...found.results.flatMap((hit) => (hit.threadId ? [hit.threadId] : []))
      );
    }
    return result;
  }

  relevantChecks(
    workspaceId: string,
    owner: User,
    evidence: Evidence[],
    threadIds: string[]
  ): FutureCheck[] {
    const sourceIds = new Set([
      ...evidence.map((item) => item.id),
      ...[
        ...this.conversationRows(workspaceId, owner, evidence),
        ...this.matches(workspaceId, owner, evidence),
      ].map((row) => row.id),
    ]);
    return this.checks(workspaceId, owner)
      .filter(
        (check) =>
          (check.threadId !== null && threadIds.includes(check.threadId)) ||
          check.sourceIds.some((id) => sourceIds.has(id))
      )
      .slice(0, 12);
  }

  channels(workspaceId: string, owner: User): AssessmentInput["channels"] {
    this.workspaces.requireMember(workspaceId, owner);
    return this.workspaces.channelsIn(workspaceId, owner.id).map((channel) => ({
      id: channel.id,
      name: channel.name,
      summary: channel.summary,
      private: channel.ownerId !== null,
    }));
  }

  async relatedEvidence(
    workspaceId: string,
    owner: User,
    fresh: Evidence[],
    checks: FutureCheck[]
  ): Promise<Evidence[]> {
    const result = new Map(fresh.map((item) => [item.id, item]));
    const originals: Evidence[] = [];
    for (const id of new Set(checks.flatMap((check) => check.sourceIds))) {
      const row = this.database
        .query(
          "SELECT * FROM intake_item WHERE id=? AND workspace_id=? AND owner_id=?"
        )
        .get(id, workspaceId, owner.id) as ItemRow | null;
      if (row && this.visible(workspaceId, owner, [row]).length) {
        const item = this.evidence([row])[0]!;
        result.set(id, item);
        originals.push(item);
      }
    }
    const candidates = [
      ...this.conversationRows(workspaceId, owner, [...fresh, ...originals]),
      ...this.matches(workspaceId, owner, [...fresh, ...originals]),
    ];
    let size = 0,
      count = 0;
    for (const item of this.evidence(candidates)) {
      if (
        result.has(item.id) ||
        count >= 12 ||
        size + item.text.length > 8000
      ) {
        continue;
      }
      result.set(item.id, item);
      size += item.text.length;
      count += 1;
    }
    return [...result.values()].sort((a, b) => a.at - b.at);
  }

  private conversationRows(
    workspaceId: string,
    owner: User,
    evidence: Evidence[]
  ): ItemRow[] {
    const rows = this.database
      .query(`SELECT DISTINCT i.* FROM intake_item i JOIN intake_item original
      ON i.credential_id=original.credential_id AND json_extract(i.payload,'$.chat')=json_extract(original.payload,'$.chat')
      WHERE original.id IN (SELECT value FROM json_each(?)) AND original.workspace_id=? AND original.owner_id=?
      AND i.workspace_id=? AND i.owner_id=? AND i.superseded_at IS NULL ORDER BY i.at DESC LIMIT 24`)
      .all(
        JSON.stringify(evidence.map((item) => item.id)),
        workspaceId,
        owner.id,
        workspaceId,
        owner.id
      ) as ItemRow[];
    return this.visible(workspaceId, owner, rows);
  }

  private matches(
    workspaceId: string,
    owner: User,
    evidence: Evidence[]
  ): ItemRow[] {
    const terms = [
      ...new Set(
        evidence
          .map((item) => item.text.slice(0, 1000))
          .join(" ")
          .match(/[\p{L}\p{N}@.]{4,}/gu) ?? []
      ),
    ].slice(0, 24);
    if (!terms.length) {
      return [];
    }
    const match = terms
      .map((word) => `"${word.replaceAll('"', '""')}"`)
      .join(" OR ");
    const rows = this.database
      .query(
        "SELECT i.* FROM intake_fts f JOIN intake_item i ON i.rowid=f.rowid WHERE intake_fts MATCH ? AND i.superseded_at IS NULL AND i.workspace_id=? AND i.owner_id=? AND i.id NOT IN (SELECT value FROM json_each(?)) ORDER BY bm25(intake_fts),i.at DESC LIMIT 6"
      )
      .all(
        match,
        workspaceId,
        owner.id,
        JSON.stringify(evidence.map((item) => item.id))
      ) as ItemRow[];
    return this.visible(workspaceId, owner, rows);
  }

  evidence(rows: ItemRow[]): Evidence[] {
    return rows.map((row) => {
      const item = JSON.parse(row.payload) as WatchedItem & { source: string };
      return {
        id: row.id,
        conversation: `${row.credential_id}:${item.chat}`,
        bulk: item.bulk,
        attachments: item.attachments?.map(({ name, type, size }) => ({
          name,
          type,
          size,
        })),
        text: item.text,
        at: item.at,
        ...(item.observedAt === undefined
          ? {}
          : { observedAt: item.observedAt }),
        source: `${item.source}; ${item.chatName}; ${item.sender}`,
        url: item.url,
        fromOwner: item.fromOwner,
      };
    });
  }

  checks(workspaceId: string, owner: User): FutureCheck[] {
    this.workspaces.requireMember(workspaceId, owner);
    return (
      this.database
        .query(
          "SELECT * FROM intake_check WHERE workspace_id=? AND owner_id=? AND state='open' AND deleted_at IS NULL ORDER BY check_at"
        )
        .all(workspaceId, owner.id) as CheckRow[]
    )
      .filter((row) => this.visibleCheck(workspaceId, owner, row))
      .map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        text: row.text,
        sourceIds: JSON.parse(row.source_ids),
        checkAt: row.check_at,
        deadlineAt: row.explicit_time ? row.check_at : null,
        reviewAt: row.next_review_at,
        notifiedAt: row.notified_at,
      }));
  }

  coverage(workspaceId: string, owner: User): AssessmentInput["coverage"] {
    return (
      this.database
        .query(
          "SELECT * FROM intake_source WHERE workspace_id=? AND owner_id=?"
        )
        .all(workspaceId, owner.id) as SourceRow[]
    )
      .filter((source) =>
        this.sources(workspaceId, owner).has(source.credential_id)
      )
      .map((source) => ({
        source: source.credential_id,
        through: source.polled_at,
        error: source.error,
      }));
  }

  status(workspaceId: string, owner: User, query = "") {
    return {
      evidence: this.evidence(this.items(workspaceId, owner, query, 30)),
      checks: this.checks(workspaceId, owner),
      coverage: this.coverage(workspaceId, owner),
    };
  }

  /** The person's visible observations that match `query`, best first, or else the newest. */
  items(workspaceId: string, owner: User, query: string, limit: number) {
    this.workspaces.requireMember(workspaceId, owner);
    const terms = (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 32);
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    const rows = match
      ? (this.database
          .query(
            "SELECT i.* FROM intake_fts f JOIN intake_item i ON i.rowid=f.rowid WHERE (intake_fts MATCH ?) AND i.workspace_id=? AND i.owner_id=? ORDER BY bm25(intake_fts),i.at DESC LIMIT ?"
          )
          .all(match, workspaceId, owner.id, limit) as ItemRow[])
      : (this.database
          .query(
            "SELECT * FROM intake_item WHERE superseded_at IS NULL AND workspace_id=? AND owner_id=? ORDER BY at DESC LIMIT ?"
          )
          .all(workspaceId, owner.id, limit) as ItemRow[]);
    return this.visible(workspaceId, owner, rows);
  }

  /** Each account that the person lets Golem read: how far Golem read it, its error, and how much it keeps. */
  sourceStatus(workspaceId: string, owner: User): IntakeSourceStatus[] {
    this.workspaces.requireMember(workspaceId, owner);
    return this.integrations
      .watched()
      .filter(
        (each) => each.workspaceId === workspaceId && each.ownerId === owner.id
      )
      .map((credential) => {
        const row = this.database
          .query(
            "SELECT polled_at,error,(SELECT count(*) FROM intake_item WHERE credential_id=? AND superseded_at IS NULL) AS kept FROM intake_source WHERE credential_id=?"
          )
          .get(credential.id, credential.id) as {
          polled_at: number;
          error: string | null;
          kept: number;
        } | null;
        return {
          id: credential.id,
          name: `${credential.integrationName} · ${credential.label}`,
          readAt: row?.polled_at || null,
          error: row?.error ?? null,
          kept: row?.kept ?? 0,
        };
      });
  }
  visible(workspaceId: string, owner: User, rows: ItemRow[]): ItemRow[] {
    const sources = this.sources(workspaceId, owner);
    return rows.filter((row) => sources.has(row.credential_id));
  }

  private sources(workspaceId: string, owner: User): Set<string> {
    this.workspaces.requireMember(workspaceId, owner);
    return new Set([
      ...this.integrations
        .watched()
        .filter(
          (each) =>
            each.workspaceId === workspaceId && each.ownerId === owner.id
        )
        .map((each) => each.id),
      ...this.workspaces
        .threadsIn(workspaceId, owner.id)
        .map((each) => `thread:${each.id}`),
    ]);
  }

  private visibleCheck(
    workspaceId: string,
    owner: User,
    check: CheckRow
  ): boolean {
    if (
      check.thread_id &&
      !this.workspaces
        .threadsIn(workspaceId, owner.id)
        .some((thread) => thread.id === check.thread_id)
    ) {
      return false;
    }
    const ids = JSON.parse(check.source_ids) as string[];
    return ids.every((id) => {
      const row = this.database
        .query(
          "SELECT * FROM intake_item WHERE id=? AND workspace_id=? AND owner_id=?"
        )
        .get(id, workspaceId, owner.id) as ItemRow | null;
      return row !== null && this.visible(workspaceId, owner, [row]).length > 0;
    });
  }
}

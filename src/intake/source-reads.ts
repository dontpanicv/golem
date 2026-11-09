import type { Database } from "bun:sqlite";
import type {
  SourceRead,
  WatchedCredential,
  WatchedItem,
} from "../integrations/integrations.ts";
import type { User } from "../platform/auth.ts";
import type { ChatRef } from "../workspaces/workspaces.ts";
import type { Audit } from "./audit.ts";
import type { IntakeIntegrations, IntakeWorkspaces } from "./intake.ts";
import type { IntakeRecall, ItemRow } from "./recall.ts";

interface ReadRow {
  id: string;
  chat_id: string;
  source_ids: string;
}

/** Durable source reads are evidence for existing checks, never a person's correction. */
export class SourceReads {
  constructor(
    private readonly database: Database,
    private readonly workspaces: IntakeWorkspaces,
    private readonly integrations: IntakeIntegrations,
    private readonly audit: Audit,
    /** Keeps an observation; a new one that intake has not seen waits for the normal assessment, so it gets its follow-up. */
    private readonly keep: (
      credential: WatchedCredential,
      item: WatchedItem
    ) => string
  ) {}

  capture(chat: ChatRef, owner: User, read: SourceRead, now: number): void {
    this.workspaces.requireMember(chat.workspaceId, owner);
    const credential = this.integrations
      .watched()
      .find(
        (each) =>
          each.id === read.credential.id &&
          each.workspaceId === chat.workspaceId &&
          each.ownerId === owner.id
      );
    if (
      !(
        credential &&
        this.workspaces
          .chatsIn(chat.workspaceId, owner.id)
          .some((each) => each.id === chat.id)
      )
    ) {
      return;
    }
    const fingerprint = read.items.map(({ observedAt, at, ...item }) => ({
      ...item,
      at: observedAt === undefined ? at : null,
    }));
    const id = new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify([
          chat.workspaceId,
          owner.id,
          chat.id,
          credential.id,
          read.tool,
          fingerprint,
        ])
      )
      .digest("hex");
    this.audit.record(
      id,
      "source.read",
      chat.workspaceId,
      owner.id,
      {
        tool: read.tool,
        credentialId: credential.id,
        chatId: chat.id,
        result: credential.integration === "google" ? read.items : read.result,
      },
      now
    );
    if (
      this.database.query("SELECT 1 FROM intake_source_read WHERE id=?").get(id)
    ) {
      this.database
        .query(
          "UPDATE intake_source_read SET assessed_at=NULL WHERE id=? AND assessed_at IS NOT NULL AND EXISTS(SELECT 1 FROM intake_check WHERE workspace_id=? AND owner_id=? AND chat_id=? AND state='open' AND deleted_at IS NULL AND revised_at>intake_source_read.assessed_at)"
        )
        .run(id, chat.workspaceId, owner.id, chat.id);
      return;
    }
    this.database.transaction(() => {
      const ids = read.items.map((item) => {
        const sourceId = this.keep(credential, item);
        this.database
          .query(
            "UPDATE intake_item SET chat_id=coalesce(chat_id,?) WHERE id=?"
          )
          .run(chat.id, sourceId);
        return sourceId;
      });
      this.database
        .query(
          "INSERT INTO intake_source_read(id,workspace_id,owner_id,chat_id,credential_id,source_ids,observed_at) VALUES(?,?,?,?,?,?,?)"
        )
        .run(
          id,
          chat.workspaceId,
          owner.id,
          chat.id,
          credential.id,
          JSON.stringify(ids),
          now
        );
    })();
  }

  pending(
    workspaceId: string,
    owner: User,
    recall: IntakeRecall,
    chatId?: string
  ) {
    this.workspaces.requireMember(workspaceId, owner);
    const credentials = this.integrations
      .watched()
      .filter(
        (credential) =>
          credential.workspaceId === workspaceId &&
          credential.ownerId === owner.id
      )
      .map((credential) => credential.id);
    const chats = this.workspaces
      .chatsIn(workspaceId, owner.id)
      .map((chat) => chat.id);
    const rows = this.database
      .query(
        "SELECT r.id,r.chat_id,r.source_ids FROM intake_source_read r WHERE r.workspace_id=? AND r.owner_id=? AND r.assessed_at IS NULL AND r.deleted_at IS NULL AND (? IS NULL OR r.chat_id=?) AND r.credential_id IN (SELECT value FROM json_each(?)) AND r.chat_id IN (SELECT value FROM json_each(?)) ORDER BY r.observed_at,r.id LIMIT 1000"
      )
      .all(
        workspaceId,
        owner.id,
        chatId ?? null,
        chatId ?? null,
        JSON.stringify(credentials),
        JSON.stringify(chats)
      ) as ReadRow[];
    return [...Map.groupBy(rows, (row) => row.chat_id)].map(([id, reads]) => ({
      chatId: id,
      reads,
      evidence: recall.visible(
        workspaceId,
        owner,
        this.database
          .query(
            "SELECT * FROM intake_item WHERE workspace_id=? AND owner_id=? AND superseded_at IS NULL AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY at,id"
          )
          .all(
            workspaceId,
            owner.id,
            JSON.stringify([
              ...new Set(
                reads.flatMap((read) => JSON.parse(read.source_ids) as string[])
              ),
            ])
          ) as ItemRow[]
      ),
    }));
  }

  finish(reads: ReadRow[], now: number): void {
    for (const read of reads) {
      this.database
        .query("UPDATE intake_source_read SET assessed_at=? WHERE id=?")
        .run(now, read.id);
    }
  }
}

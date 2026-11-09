import type { Database } from "bun:sqlite";
import type { FileRef } from "../chats/chats.ts";
import type { WatchedItem } from "../integrations/integrations.ts";
import type { User } from "../platform/auth.ts";
import type { Audit } from "./audit.ts";
import type {
  IntakeChats,
  IntakeIntegrations,
  IntakeWorkspaces,
} from "./intake.ts";
import type { ItemRow } from "./recall.ts";

interface ArchiveRow {
  id: string;
  workspace_id: string;
  owner_id: string;
  topic_id: string;
  credential_id: string;
  integration: string;
  conversation: string;
  period: string;
  item_ids: string;
  file_id: string | null;
  content_hash: string | null;
  pending: number;
  attachment_ids: string;
  obsolete_ids: string;
}
interface Observation {
  row: ItemRow;
  item: WatchedItem & { source?: string };
}
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Derived conversation files. Message-level originals remain in the evidence store and audit. */
export class IntakeArchives {
  constructor(
    private readonly database: Database,
    private readonly workspaces: IntakeWorkspaces,
    private readonly integrations: IntakeIntegrations,
    private readonly chats: Pick<
      IntakeChats,
      "files" | "file" | "place" | "writeFile" | "deleteFile"
    >,
    private readonly audit: Audit,
    private readonly signal: AbortSignal
  ) {}

  async save(
    workspaceId: string,
    topicId: string,
    owner: User,
    rows: ItemRow[]
  ): Promise<FileRef[]> {
    this.workspaces.requireMember(workspaceId, owner);
    this.chats.place(workspaceId, topicId, owner);
    const groups = this.stage(workspaceId, topicId, owner, rows);
    const files: FileRef[] = [];
    for (const id of groups) {
      files.push(...(await this.flush(id, owner)));
    }
    return files;
  }

  /**
   * Takes deleted observations out of the conversation files that hold them: a file left with no observation goes with
   * its attachments, and another is written again without them. Deleted files move aside, as every delete does.
   */
  async forget(
    workspaceId: string,
    owner: User,
    itemIds: readonly string[]
  ): Promise<void> {
    const groups = this.database
      .query(
        "SELECT * FROM intake_archive WHERE workspace_id=? AND owner_id=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM json_each(item_ids) WHERE value IN (SELECT value FROM json_each(?)))"
      )
      .all(workspaceId, owner.id, JSON.stringify(itemIds)) as ArchiveRow[];
    for (const group of groups) {
      const left = this.observations(group);
      const saved = JSON.parse(group.attachment_ids) as Record<string, FileRef>;
      const kept = new Set(
        left.flatMap(({ row, item }) =>
          (item.attachments ?? []).map((attachment) =>
            hash(JSON.stringify([row.source_id, attachment.id]))
          )
        )
      );
      // A file that the person or an agent edited is their work: it stays.
      const whole =
        left.length === 0 &&
        group.file_id !== null &&
        !(await this.edited(group, owner));
      const gone = [
        ...Object.entries(saved)
          .filter(([key]) => !kept.has(key))
          .map(([, file]) => file.id),
        ...(whole ? [group.file_id!] : []),
      ];
      for (const fileId of gone) {
        // A file that the person deleted already is gone too.
        await this.chats
          .deleteFile(workspaceId, owner, fileId)
          .catch(() => undefined);
      }
      const attachments = JSON.stringify(
        Object.fromEntries(
          Object.entries(saved).filter(([key]) => kept.has(key))
        )
      );
      if (left.length === 0) {
        this.database
          .query(
            "UPDATE intake_archive SET deleted_at=?,attachment_ids=? WHERE id=?"
          )
          .run(Date.now(), attachments, group.id);
      } else {
        this.database
          .query(
            "UPDATE intake_archive SET item_ids=?,attachment_ids=?,pending=1 WHERE id=?"
          )
          .run(
            JSON.stringify(left.map(({ row }) => row.id)),
            attachments,
            group.id
          );
        await this.resume(group.id, workspaceId, owner);
      }
      this.audit.record(group.id, "archive.forgotten", workspaceId, owner.id, {
        itemIds,
        files: gone,
      });
    }
  }

  /** Whether the conversation file changed since Golem wrote it, as when the person added notes. */
  private async edited(group: ArchiveRow, owner: User): Promise<boolean> {
    if (group.file_id === null || group.content_hash === null) {
      return false;
    }
    try {
      const { path } = await this.chats.file(
        group.workspace_id,
        owner,
        group.file_id
      );
      return hash(await Bun.file(path).text()) !== group.content_hash;
    } catch {
      // A file that is already gone has no edits to keep.
      return false;
    }
  }

  /** Repairs interrupted writes. */
  async maintain(workspaceId: string, owner: User): Promise<void> {
    this.workspaces.requireMember(workspaceId, owner);
    const pending = this.database
      .query(
        "SELECT id FROM intake_archive WHERE workspace_id=? AND owner_id=? AND deleted_at IS NULL AND pending=1"
      )
      .all(workspaceId, owner.id) as { id: string }[];
    for (const group of pending) {
      await this.resume(group.id, workspaceId, owner);
    }
  }

  private async resume(
    id: string,
    workspaceId: string,
    owner: User
  ): Promise<boolean> {
    try {
      await this.flush(id, owner);
      return true;
    } catch (error) {
      this.audit.record(id, "archive.error", workspaceId, owner.id, {
        error: String(error),
      });
      return false;
    }
  }

  private stage(
    workspaceId: string,
    topicId: string,
    owner: User,
    rows: ItemRow[]
  ): string[] {
    const credentials = this.integrations.watched();
    const grouped = new Map<
      string,
      { row: ArchiveRow; observations: Observation[] }
    >();
    for (const candidate of rows) {
      const credential = credentials.find(
        (each) =>
          each.id === candidate.credential_id &&
          each.workspaceId === workspaceId &&
          each.ownerId === owner.id
      );
      if (
        !credential ||
        candidate.workspace_id !== workspaceId ||
        candidate.owner_id !== owner.id
      ) {
        continue;
      }
      const row = this.database
        .query(
          "SELECT * FROM intake_item WHERE credential_id=? AND id=? AND workspace_id=? AND owner_id=? AND deleted_at IS NULL"
        )
        .get(
          credential.id,
          candidate.id,
          workspaceId,
          owner.id
        ) as ItemRow | null;
      if (!row) {
        continue;
      }
      const item = JSON.parse(row.payload) as WatchedItem;
      const daily =
        credential.integration === "whatsapp" ||
        (credential.integration === "slack" && !item.chat.includes("/"));
      const period = daily ? calendarDay(item.at) : "";
      const id = hash(
        JSON.stringify([
          workspaceId,
          owner.id,
          topicId,
          credential.id,
          item.chat,
          period,
        ])
      );
      let group = grouped.get(id);
      if (!group) {
        const saved = this.database
          .query(
            "SELECT * FROM intake_archive WHERE id=? AND deleted_at IS NULL"
          )
          .get(id) as ArchiveRow | null;
        group = {
          row: saved ?? {
            id,
            workspace_id: workspaceId,
            owner_id: owner.id,
            topic_id: topicId,
            credential_id: credential.id,
            integration: credential.integration,
            conversation: item.chat,
            period,
            item_ids: "[]",
            file_id: null,
            content_hash: null,
            pending: 1,
            attachment_ids: "{}",
            obsolete_ids: "[]",
          },
          observations: [],
        };
        grouped.set(id, group);
      }
      group.observations.push({ row, item });
    }
    this.database.transaction(() => {
      for (const { row, observations } of grouped.values()) {
        const members = new Map(
          this.observations(row).map((each) => [each.row.source_id, each])
        );
        for (const observation of observations) {
          if (
            observation.row.superseded_at !== null &&
            members.has(observation.row.source_id)
          ) {
            continue;
          }
          if (
            members.get(observation.row.source_id)?.row.id !==
            observation.row.id
          ) {
            members.delete(observation.row.source_id);
            members.set(observation.row.source_id, observation);
          }
        }
        const ids = [...members.values()].map((each) => each.row.id);
        this.database
          .query(
            "INSERT INTO intake_archive(id,workspace_id,owner_id,topic_id,credential_id,integration,conversation,period,item_ids) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET item_ids=excluded.item_ids,pending=CASE WHEN item_ids!=excluded.item_ids OR deleted_at IS NOT NULL THEN 1 ELSE pending END,file_id=CASE WHEN deleted_at IS NULL THEN file_id END,content_hash=CASE WHEN deleted_at IS NULL THEN content_hash END,attachment_ids=CASE WHEN deleted_at IS NULL THEN attachment_ids ELSE '{}' END,deleted_at=NULL"
          )
          .run(
            row.id,
            workspaceId,
            owner.id,
            topicId,
            row.credential_id,
            row.integration,
            row.conversation,
            row.period,
            JSON.stringify(ids)
          );
      }
    })();
    return [...grouped.keys()];
  }

  private async flush(id: string, owner: User): Promise<FileRef[]> {
    const group = this.database
      .query(
        "SELECT * FROM intake_archive WHERE id=? AND owner_id=? AND deleted_at IS NULL"
      )
      .get(id, owner.id) as ArchiveRow | null;
    if (!group) {
      return [];
    }
    this.workspaces.requireMember(group.workspace_id, owner);
    const credential = this.integrations
      .watched()
      .find(
        (each) =>
          each.id === group.credential_id &&
          each.workspaceId === group.workspace_id &&
          each.ownerId === owner.id
      );
    if (!credential) {
      return [];
    }
    const observations = this.observations(group);
    if (group.integration !== "plaud") {
      observations.sort(
        (a, b) =>
          a.item.at - b.item.at ||
          a.row.source_id.localeCompare(b.row.source_id)
      );
    }
    if (!observations.length) {
      return [];
    }
    const place = this.chats.place(group.workspace_id, group.topic_id, owner);
    const stored = await this.chats.files(place);
    const attachments = await this.attachments(
      group,
      owner,
      observations,
      stored
    );
    const title = observations[0]!.item.chatName || "Source";
    const name = `${safeName(title).slice(0, 80)}${group.period ? `-${group.period}` : ""}-${group.id.slice(0, 12)}.md`;
    const text = render(group, observations, attachments);
    const digest = hash(text);
    let source =
      stored.find((file) => file.id === group.file_id) ??
      stored.find((file) => file.name.endsWith(`-${group.id.slice(0, 12)}.md`));
    let currentHash: string | null = null;
    if (source) {
      const storedFile = await this.chats.file(
        group.workspace_id,
        owner,
        source.id
      );
      currentHash = hash(await Bun.file(storedFile.path).text());
      if (
        group.content_hash !== null &&
        currentHash !== group.content_hash &&
        currentHash !== digest
      ) {
        this.audit.record(
          group.id,
          "archive.edited",
          group.workspace_id,
          owner.id,
          { preserved: source.id }
        );
        source = undefined;
      }
    }
    if (!source || currentHash !== digest) {
      const saved = await this.chats.writeFile(
        group.workspace_id,
        group.topic_id,
        owner,
        new File([text], name, { type: "text/markdown" }),
        source?.id
      );
      source = { ...saved, size: text.length, time: Date.now() };
    }
    const sourceFile = { id: source.id, name: source.name };
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE intake_archive SET file_id=?,content_hash=?,pending=0 WHERE id=?"
        )
        .run(sourceFile.id, digest, group.id);
      this.database
        .query(
          "UPDATE intake_item SET archived_id=? WHERE workspace_id=? AND owner_id=? AND credential_id=? AND source_id IN (SELECT source_id FROM intake_item WHERE id IN (SELECT value FROM json_each(?)))"
        )
        .run(
          sourceFile.id,
          group.workspace_id,
          owner.id,
          group.credential_id,
          group.item_ids
        );
    })();
    this.audit.record(group.id, "archive.saved", group.workspace_id, owner.id, {
      topic: group.topic_id,
      file: sourceFile,
      itemIds: observations.map((each) => each.row.id),
      contentHash: digest,
    });
    return [sourceFile, ...Object.values(attachments)];
  }

  private observations(group: ArchiveRow): Observation[] {
    return (
      this.database
        .query(
          "SELECT i.* FROM json_each(?) m JOIN intake_item i ON i.id=m.value WHERE i.workspace_id=? AND i.owner_id=? AND i.credential_id=? AND i.deleted_at IS NULL ORDER BY CAST(m.key AS INTEGER)"
        )
        .all(
          group.item_ids,
          group.workspace_id,
          group.owner_id,
          group.credential_id
        ) as ItemRow[]
    ).map((row) => ({ row, item: JSON.parse(row.payload) as WatchedItem }));
  }

  private async attachments(
    group: ArchiveRow,
    owner: User,
    observations: Observation[],
    stored: FileRef[]
  ): Promise<Record<string, FileRef>> {
    const saved = JSON.parse(group.attachment_ids) as Record<string, FileRef>;
    for (const { row, item } of observations) {
      for (const attachment of item.attachments ?? []) {
        const key = hash(JSON.stringify([row.source_id, attachment.id]));
        if (saved[key] && stored.some((file) => file.id === saved[key]!.id)) {
          continue;
        }
        if (
          attachment.size > 10_000_000 ||
          !/^(application\/pdf|image\/|text\/calendar)/.test(attachment.type)
        ) {
          this.audit.record(
            row.id,
            "attachment.skipped",
            group.workspace_id,
            owner.id,
            { attachment, reason: "Unsupported type or size" }
          );
          continue;
        }
        try {
          saved[key] = await this.saveAttachment(
            group,
            owner,
            row,
            attachment,
            stored
          );
        } catch (error) {
          // One attachment that the source no longer gives, or that is too large, never stops the conversation.
          this.audit.record(
            row.id,
            "attachment.skipped",
            group.workspace_id,
            owner.id,
            { attachment, reason: String(error) }
          );
          continue;
        }
        this.database
          .query("UPDATE intake_archive SET attachment_ids=? WHERE id=?")
          .run(JSON.stringify(saved), group.id);
      }
    }
    return saved;
  }
  private async saveAttachment(
    group: ArchiveRow,
    owner: User,
    row: ItemRow,
    attachment: NonNullable<WatchedItem["attachments"]>[number],
    stored: FileRef[]
  ): Promise<FileRef> {
    const key = hash(JSON.stringify([row.source_id, attachment.id]));
    const name = `${key.slice(0, 12)}-${safeName(attachment.name)}`;
    const existing = stored.find(
      (file) =>
        file.name === `${row.id.slice(0, 12)}-${safeName(attachment.name)}` ||
        file.name === name
    );
    if (existing) {
      return { id: existing.id, name: existing.name };
    }
    const bytes = await this.integrations.attachment(
      group.credential_id,
      row.source_id,
      attachment.id,
      this.signal
    );
    if (bytes.byteLength > 10_000_000) {
      throw new Error("Attachment exceeds 10 MB");
    }
    const blob = this.audit.blob(bytes, attachment.type);
    this.audit.record(
      row.id,
      "attachment.downloaded",
      group.workspace_id,
      owner.id,
      { attachment, hash: blob }
    );
    return this.chats.writeFile(
      group.workspace_id,
      group.topic_id,
      owner,
      new File([bytes], name, { type: attachment.type })
    );
  }
}

function render(
  group: ArchiveRow,
  observations: Observation[],
  attachments: Record<string, FileRef>
): string {
  // Plaud can supply several versions or types of a summary for the same recording.
  const selected =
    group.integration === "plaud" ? observations.slice(-1) : observations;
  const first = observations[0]!.item;
  const sections = [
    `# ${first.chatName || "Source"}${group.period ? ` · ${group.period}` : ""}`,
    first.source ?? group.integration,
    ...selected.map(({ row, item }) => {
      const files = (item.attachments ?? []).flatMap((attachment) => {
        const file =
          attachments[hash(JSON.stringify([row.source_id, attachment.id]))];
        return file ? [`[${safeName(attachment.name)}](file:${file.id})`] : [];
      });
      return `## ${new Date(item.at).toISOString()} · ${item.fromOwner ? "Account owner" : item.sender || "Source"}\n\n${item.url ?? ""}\n\nSource message: ${row.source_id}\n\n${item.text}${files.length ? `\n\n${files.join("\n")}` : ""}`;
    }),
  ];
  return `${sections.join("\n\n")}\n`;
}

function calendarDay(at: number): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join("-");
}

function hash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** A file name without separators or control characters, at most 150 bytes, keeping its extension. */
function safeName(name: string): string {
  const clean =
    name
      // biome-ignore lint/suspicious/noControlCharactersInRegex: file names must not contain control characters
      .replace(/[/\\\u0000-\u001f]/g, "-")
      .replace(/^\.+/, "")
      .trim() || "attachment";
  const dot = clean.lastIndexOf(".");
  const extension = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";
  // Stored names add about 50 bytes, and a file name has at most 255.
  const stem = [...clean.slice(0, clean.length - extension.length)];
  while (
    stem.length > 1 &&
    Buffer.byteLength(stem.join("") + extension) > 150
  ) {
    stem.pop();
  }
  return stem.join("") + extension;
}

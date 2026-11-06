import type { Database } from "bun:sqlite";
import type { WatchedItem } from "../integrations/integrations.ts";
import type { User } from "../platform/auth.ts";
import { setSetting, setting } from "../platform/database.ts";
import type { FileRef } from "../threads/threads.ts";
import type { Audit } from "./audit.ts";
import type {
  IntakeIntegrations,
  IntakeThreads,
  IntakeWorkspaces,
} from "./intake.ts";
import type { ItemRow } from "./recall.ts";

interface ArchiveRow {
  id: string;
  workspace_id: string;
  owner_id: string;
  channel_id: string;
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
    private readonly threads: Pick<
      IntakeThreads,
      "files" | "file" | "place" | "writeFile" | "deleteFile"
    >,
    private readonly audit: Audit,
    private readonly signal: AbortSignal
  ) {}

  async save(
    workspaceId: string,
    channelId: string,
    owner: User,
    rows: ItemRow[]
  ): Promise<FileRef[]> {
    this.workspaces.requireMember(workspaceId, owner);
    this.threads.place(workspaceId, channelId, owner);
    const groups = this.stage(workspaceId, channelId, owner, rows, {});
    const files: FileRef[] = [];
    for (const id of groups) {
      files.push(...(await this.flush(id, owner)));
    }
    return files;
  }

  /** Repairs interrupted writes, then folds old per-message files without a model or new source reads. */
  async maintain(workspaceId: string, owner: User): Promise<void> {
    this.workspaces.requireMember(workspaceId, owner);
    const pending = this.database
      .query(
        "SELECT id FROM intake_archive WHERE workspace_id=? AND owner_id=? AND deleted_at IS NULL AND (pending=1 OR obsolete_ids!='[]')"
      )
      .all(workspaceId, owner.id) as { id: string }[];
    for (const group of pending) {
      await this.resume(group.id, workspaceId, owner);
    }
    const watched = new Set(
      this.integrations
        .watched()
        .filter(
          (each) =>
            each.workspaceId === workspaceId && each.ownerId === owner.id
        )
        .map((each) => each.id)
    );
    const progressKey = `intake.conversation-archives:${workspaceId}:${owner.id}`;
    const accounts = hash(
      [...watched].sort((left, right) => left.localeCompare(right)).join(":")
    );
    if (setting(this.database, progressKey) === accounts) {
      return;
    }
    let complete = true;
    const rows = this.database
      .query(
        "SELECT * FROM intake_item WHERE workspace_id=? AND owner_id=? AND archived_id IS NOT NULL"
      )
      .all(workspaceId, owner.id) as ItemRow[];
    if (!rows.length) {
      setSetting(this.database, progressKey, accounts);
      return;
    }
    const remaining = rows.filter((row) => watched.has(row.credential_id));
    for (const channel of this.workspaces.channelsIn(workspaceId, owner.id)) {
      const files = await this.threads.files(
        this.threads.place(workspaceId, channel.id, owner)
      );
      const selected: ItemRow[] = [];
      const obsolete: Record<string, string> = {};
      for (const row of remaining) {
        const file = files.find((each) =>
          each.name.endsWith(`-${row.id.slice(0, 12)}.md`)
        );
        if (!file) {
          continue;
        }
        const item = JSON.parse(row.payload) as WatchedItem;
        const original = `# ${item.chatName}\n\n${item.url ?? ""}\n\nWritten: ${new Date(item.at).toISOString()}\nFrom: ${item.sender}\n\n${item.text}`;
        const { path } = await this.threads.file(workspaceId, owner, file.id);
        // A file the person or agent edited is their work, not an old generated copy.
        if ((await Bun.file(path).text()) !== original) {
          continue;
        }
        selected.push(row);
        obsolete[row.id] = file.id;
      }
      for (const id of this.stage(
        workspaceId,
        channel.id,
        owner,
        selected,
        obsolete
      )) {
        complete = (await this.resume(id, workspaceId, owner)) && complete;
      }
    }
    if (complete) {
      setSetting(this.database, progressKey, accounts);
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
    channelId: string,
    owner: User,
    rows: ItemRow[],
    obsolete: Record<string, string>
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
          "SELECT * FROM intake_item WHERE credential_id=? AND id=? AND workspace_id=? AND owner_id=?"
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
          channelId,
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
            channel_id: channelId,
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
        const retired = [
          ...new Set([
            ...(JSON.parse(row.obsolete_ids) as string[]),
            ...rows
              .filter((each) =>
                observations.some(
                  (observation) =>
                    observation.row.source_id === each.source_id &&
                    observation.row.credential_id === each.credential_id
                )
              )
              .flatMap((each) =>
                obsolete[each.id] ? [obsolete[each.id]!] : []
              ),
          ]),
        ];
        this.database
          .query(
            "INSERT INTO intake_archive(id,workspace_id,owner_id,channel_id,credential_id,integration,conversation,period,item_ids,obsolete_ids) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET item_ids=excluded.item_ids,obsolete_ids=excluded.obsolete_ids,pending=CASE WHEN item_ids!=excluded.item_ids THEN 1 ELSE pending END"
          )
          .run(
            row.id,
            workspaceId,
            owner.id,
            channelId,
            row.credential_id,
            row.integration,
            row.conversation,
            row.period,
            JSON.stringify(ids),
            JSON.stringify(retired)
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
      .get(id, owner.id) as ArchiveRow;
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
    const place = this.threads.place(
      group.workspace_id,
      group.channel_id,
      owner
    );
    const stored = await this.threads.files(place);
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
    const retired = JSON.parse(group.obsolete_ids) as string[];
    let source =
      stored.find((file) => file.id === group.file_id) ??
      stored.find((file) =>
        file.name.endsWith(`-${group.id.slice(0, 12)}.md`)
      ) ??
      stored.find((file) => retired.includes(file.id));
    let currentHash: string | null = null;
    if (source) {
      const storedFile = await this.threads.file(
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
      const saved = await this.threads.writeFile(
        group.workspace_id,
        group.channel_id,
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
      channel: group.channel_id,
      file: sourceFile,
      itemIds: observations.map((each) => each.row.id),
      contentHash: digest,
    });
    for (const old of retired.filter(
      (fileId) =>
        fileId !== sourceFile.id && stored.some((each) => each.id === fileId)
    )) {
      await this.threads.deleteFile(group.workspace_id, owner, old);
      this.audit.record(
        group.id,
        "archive.consolidated",
        group.workspace_id,
        owner.id,
        { retired: old, file: sourceFile }
      );
    }
    this.database
      .query("UPDATE intake_archive SET obsolete_ids='[]' WHERE id=?")
      .run(group.id);
    return [sourceFile, ...Object.values(attachments)];
  }

  private observations(group: ArchiveRow): Observation[] {
    return (
      this.database
        .query(
          "SELECT i.* FROM json_each(?) m JOIN intake_item i ON i.id=m.value WHERE i.workspace_id=? AND i.owner_id=? AND i.credential_id=? ORDER BY CAST(m.key AS INTEGER)"
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
        saved[key] = await this.saveAttachment(
          group,
          owner,
          row,
          attachment,
          stored
        );
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
    return this.threads.writeFile(
      group.workspace_id,
      group.channel_id,
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

function safeName(name: string): string {
  return (
    name
      // biome-ignore lint/suspicious/noControlCharactersInRegex: file names must not contain control characters
      .replace(/[/\\\u0000-\u001f]/g, "-")
      .replace(/^\.+/, "")
      .trim() || "attachment"
  );
}

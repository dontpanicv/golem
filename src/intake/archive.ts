import type { WatchedItem } from "../integrations/integrations.ts";
import type { User } from "../platform/auth.ts";
import type { FileRef, Threads } from "../threads/threads.ts";
import type { Audit } from "./audit.ts";

/** Keeps a source once, including supported attachments, without starting an agent. */
export async function archiveObservation(
  threads: Pick<Threads, "files" | "place" | "upload">,
  download: (attachmentId: string) => Promise<Uint8Array>,
  audit: Audit,
  workspaceId: string,
  channelId: string,
  owner: User,
  id: string,
  item: WatchedItem
): Promise<FileRef[]> {
  const saved = await threads.files(
    threads.place(workspaceId, channelId, owner)
  );
  const suffix = id.slice(0, 12);
  const name = `${safeName(item.chatName || "Source").slice(0, 100)}-${suffix}.md`;
  let sourceId = saved.find((file) => file.name === name)?.id;
  if (!sourceId) {
    const text = `# ${item.chatName}\n\n${item.url ?? ""}\n\nWritten: ${new Date(item.at).toISOString()}\nFrom: ${item.sender}\n\n${item.text}`;
    const files = await threads.upload(workspaceId, channelId, owner, [
      new File([text], name, { type: "text/markdown" }),
    ]);
    sourceId = files.find((file) => file.name === name)?.id ?? name;
  }
  for (const attachment of item.attachments ?? []) {
    if (
      attachment.size > 10_000_000 ||
      !/^(application\/pdf|image\/|text\/calendar)/.test(attachment.type)
    ) {
      audit.record(id, "attachment.skipped", workspaceId, owner.id, {
        attachment,
        reason: "Unsupported type or size",
      });
      continue;
    }
    const attachmentName = `${suffix}-${safeName(attachment.name)}`;
    if (saved.some((file) => file.name === attachmentName)) {
      continue;
    }
    const bytes = await download(attachment.id);
    if (bytes.byteLength > 10_000_000) {
      throw new Error("Attachment exceeds 10 MB");
    }
    const hash = audit.blob(bytes, attachment.type);
    audit.record(id, "attachment.downloaded", workspaceId, owner.id, {
      attachment,
      hash,
    });
    await threads.upload(workspaceId, channelId, owner, [
      new File([bytes], attachmentName, { type: attachment.type }),
    ]);
  }
  const stored = await threads.files(
    threads.place(workspaceId, channelId, owner)
  );
  const source = stored.find((file) => file.id === sourceId);
  if (!source) {
    throw new Error("The source file was not saved");
  }
  return [
    source,
    ...stored.filter((file) => file.name.startsWith(`${suffix}-`)),
  ].map(({ id: fileId, name: fileName }) => ({ id: fileId, name: fileName }));
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

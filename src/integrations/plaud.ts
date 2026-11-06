import type { Connector, WatchedItem, WatchSource } from "./integrations.ts";

/** Keeps only returned summaries. The read time is not the recording's original time. */
export const recordingObservations: NonNullable<
  Connector["observations"]
> = async (tool, args, result) => {
  if (tool !== "plaud_get_note" || typeof args.file_id !== "string") {
    return [];
  }
  const text = summaryOf(result);
  if (!text) {
    return [];
  }
  const now = Date.now();
  return [
    {
      id: `summary:${args.file_id}`,
      kind: "document",
      chat: args.file_id,
      chatName: "Recording summary",
      group: true,
      sender: "",
      fromOwner: false,
      at: now,
      observedAt: now,
      text,
      url: `https://web.plaud.ai/file/${args.file_id}`,
    },
  ];
};

/** A recording as Plaud's `list_files` gives it; its times are UTC without an offset. */
interface Recording {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
  readonly start_at: string;
}

/** A note of a recording as Plaud's `get_note` gives it, such as its summary. */
interface Note {
  readonly data_type: string;
  readonly data_title?: string;
  readonly data_content?: string;
}

/**
 * The summaries of the recordings that came to Plaud since a time, each a document. Pending recordings survive the polling cursor. Ready summaries are rechecked within the overlap window.
 */
export async function watchRecordings({
  since,
  call,
  record,
  checkpoint,
}: WatchSource): Promise<WatchedItem[]> {
  const day = (time: number) => new Date(time).toISOString().slice(0, 10);
  const saved = (checkpoint?.value ?? {}) as {
    pending?: Recording[];
    page?: number;
    checked?: Record<string, number>;
    through?: number;
  };
  const pending = new Map(
    (saved.pending ?? []).map((recording) => [recording.id, recording])
  );
  const checked = saved.checked ?? {};
  const page = saved.page ?? 1;
  const through = saved.through ?? Date.now();
  const raw = await call("list_files", {
    date_from: day(since - 24 * 60 * 60 * 1000),
    date_to: day(Date.now() + 24 * 60 * 60 * 1000),
    page_size: 50,
    page,
  });
  record?.("raw", { tool: "list_files", response: raw });
  const listed = data<{ data?: readonly Recording[] }>(raw);
  for (const recording of listed.data ?? []) {
    if (needsSummary(recording, since, checked)) {
      pending.set(recording.id, recording);
    }
  }
  const more = (listed.data?.length ?? 0) === 50;
  if (more) {
    record?.("coverage", { complete: false, reason: "Plaud list page budget" });
  }
  if (!more) {
    record?.("coverage", { complete: true, through });
  }
  const items: WatchedItem[] = [];
  let calls = 1;
  for (const recording of pending.values()) {
    if (calls >= 8) {
      break;
    }
    const answer = await call("get_note", { file_id: recording.id });
    calls += 1;
    record?.("raw", { tool: "get_note", id: recording.id, response: answer });
    const summary = summaryOf(answer);
    if (!summary) {
      continue;
    }
    items.push({
      id: recording.id,
      kind: "document",
      chat: recording.id,
      chatName: recording.name,
      group: true,
      sender: "",
      fromOwner: false,
      at: utc(recording.start_at),
      text: `# ${recording.name}\n\n${summary}`,
      url: `https://web.plaud.ai/file/${recording.id}`,
    });
    pending.delete(recording.id);
    checked[recording.id] = Date.now();
  }
  checkpoint?.save({
    pending: [...pending.values()],
    page: more ? page + 1 : 1,
    through: more ? through : undefined,
    checked: Object.fromEntries(
      Object.entries(checked).filter(
        ([, time]) => Date.now() - time < 2 * 24 * 60 * 60_000
      )
    ),
  });
  return items;
}

function needsSummary(
  recording: Recording,
  since: number,
  checked: Record<string, number>
): boolean {
  return (
    utc(recording.created_at) >= since &&
    Date.now() - (checked[recording.id] ?? 0) >= 6 * 60 * 60_000
  );
}

function summaryOf(answer: unknown): string {
  const notes = data<readonly Note[]>(answer);
  return (Array.isArray(notes) ? notes : [])
    .filter((note) => note.data_type === "auto_sum_note" && note.data_content)
    .map((note) => note.data_content!.trim())
    .join("\n\n");
}

/** A time that Plaud gives without an offset, which is UTC. */
function utc(time: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(time) ? time : `${time}Z`);
}

/** The JSON of Plaud's answer, which its server puts in a block that marks it as untrusted data. */
function data<Value>(answer: unknown): Value {
  if (typeof answer !== "string") {
    return answer as Value;
  }
  const block = answer.match(
    /<untrusted-user-data-[^ >]+[^>]*>\n([\s\S]*)\n<\/untrusted-user-data-[^>]+>/
  );
  return JSON.parse(block ? block[1]! : answer) as Value;
}

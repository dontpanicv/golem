import { expect, test } from "bun:test";
import type { WatchSource } from "./integrations.ts";
import { recordingObservations, watchRecordings } from "./plaud.ts";

test("a source read retains Plaud summaries without inventing a recording date or keeping transcripts", async () => {
  const source = { account: "Alice", secret: async () => "unused" };
  const notes = [
    { data_type: "auto_sum_note", data_content: "The plan was accepted." },
    { data_type: "transcript", data_content: "Transcript" },
  ];
  const result = await recordingObservations(
    "plaud_get_note",
    { file_id: "meeting" },
    notes,
    source
  );
  expect(result[0]).toMatchObject({
    id: "summary:meeting",
    text: "The plan was accepted.",
  });
  expect(result[0]!.observedAt).toBe(result[0]!.at);
  expect(
    await recordingObservations("plaud_list_files", {}, notes, source)
  ).toEqual([]);
});

test("a pending Plaud summary survives later polling windows and keeps the original source", async () => {
  const at = Date.parse("2026-11-01T09:00:00Z");
  let state: unknown = {};
  let ready = false;
  const source: WatchSource = {
    since: at - 1000,
    account: "Example",
    seen: () => false,
    secret: async () => "unused",
    call: async (tool) => {
      if (tool === "list_files") {
        return {
          data: ready
            ? []
            : [
                {
                  id: "meeting",
                  name: "Garden plan",
                  created_at: new Date(at).toISOString(),
                  start_at: new Date(at).toISOString(),
                },
              ],
        };
      }
      return ready
        ? [
            {
              data_type: "auto_sum_note",
              data_content: "We chose the south garden bed.",
            },
          ]
        : [];
    },
  };
  const first = await watchRecordings({
    ...source,
    checkpoint: {
      value: state,
      save: (next) => {
        state = next;
      },
    },
  });
  expect(first).toHaveLength(0);
  ready = true;
  const later = await watchRecordings({
    ...source,
    since: at + 4 * 86_400_000,
    checkpoint: {
      value: state,
      save: (next) => {
        state = next;
      },
    },
  });
  expect(later[0]).toMatchObject({
    id: "meeting",
    text: "# Garden plan\n\nWe chose the south garden bed.",
    fromOwner: false,
  });
});

test("a Plaud poll makes at most eight calls and leaves the remaining recordings in its checkpoint", async () => {
  const now = Date.now();
  let calls = 0;
  let state: unknown;
  const records = Array.from({ length: 12 }, (_, index) => ({
    id: `meeting-${index}`,
    name: "Meeting",
    created_at: new Date(now).toISOString(),
    start_at: new Date(now).toISOString(),
  }));
  const items = await watchRecordings({
    since: now - 1000,
    account: "Example",
    seen: () => false,
    secret: async () => "unused",
    checkpoint: {
      value: {},
      save: (next) => {
        state = next;
      },
    },
    call: async (tool) => {
      calls += 1;
      return tool === "list_files"
        ? { data: records }
        : [{ data_type: "auto_sum_note", data_content: "A useful summary." }];
    },
  });
  expect(calls).toBe(8);
  expect(items).toHaveLength(7);
  expect((state as { pending: unknown[] }).pending).toHaveLength(5);
});

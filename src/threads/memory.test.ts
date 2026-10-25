import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { until } from "../../test/harness.ts";
import { Memory, type Summarizer } from "./memory.ts";

const directory = await mkdtemp(join(tmpdir(), "golem-memory-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

/** A message entry: `user` text from Alice, or an answer of the agent. */
function message(id: number, role: "user" | "assistant", text: string) {
  const timestamp = Date.UTC(2026, 9, 25, 12, id);
  return {
    id,
    conversationId: 1,
    kind: role === "user" ? "golem.message" : "pi.assistant",
    model: [
      role === "user"
        ? { role, content: `Alice: ${text}`, timestamp }
        : { role, content: [{ type: "text", text }], timestamp },
    ],
  } as unknown as EntryRecord;
}

/** A memory over `entries`, with a model that answers with `answer` and records each prompt. */
async function memoryOf(
  entries: EntryRecord[],
  answer: (prompt: string) => string | Promise<string>,
  name = crypto.randomUUID()
) {
  const prompts: string[] = [];
  const summarize: Summarizer = async (_system, prompt) => {
    prompts.push(prompt);
    return await answer(prompt);
  };
  const memory = new Memory(
    join(directory, `${name}.sqlite`),
    async (entryId) => entries.find((entry) => entry.id === entryId),
    summarize
  );
  return { memory, prompts };
}

/** The lines of a view, after its header. */
function body(view: string): string {
  return view.split("\n\n").at(-1)!;
}

/** The `start+size` heads of the view's lines. */
function heads(view: string): [number, number][] {
  return [...view.matchAll(/^(\d+)\+(\d+)\|/gm)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);
}

test("a message that fits is its own line, and lines that fit together join without the model", async () => {
  const entries = [
    message(1, "user", "Plan the trip to Prague"),
    message(2, "assistant", "Which dates?"),
    { id: 3, conversationId: 1, kind: "pi.system", model: [] },
    message(4, "user", "The first weekend of May"),
    message(5, "assistant", "Noted."),
  ] as EntryRecord[];
  const { memory, prompts } = await memoryOf(entries, () => "unused");
  memory.add(entries);
  memory.add(entries);

  expect(memory.count()).toBe(4);
  expect(prompts).toEqual([]);
  expect(memory.view(4)).toEndWith(
    [
      "0+1|user: Alice: Plan the trip to Prague",
      "1+1|golem: Which dates?",
      "2+1|user: Alice: The first weekend of May",
      "3+1|golem: Noted.",
    ].join("\n")
  );
  expect(await memory.zoom(0, 4)).toBe(
    [
      "0+2|user: Alice: Plan the trip to Prague golem: Which dates?",
      "2+2|user: Alice: The first weekend of May golem: Noted.",
    ].join("\n")
  );
  expect(await memory.zoom(2, 1)).toBe(
    "Message 2, 2026-10-25 12:04 UTC:\nuser: Alice: The first weekend of May"
  );
  await expect(memory.zoom(1, 2)).rejects.toThrow("There is no line 1+2");
  await expect(memory.zoom(0, 3)).rejects.toThrow("There is no line 0+3");
  await expect(memory.zoom(4, 1)).rejects.toThrow("There is no line 4+1");
  memory.close();
});

test("the model summarizes long messages and merges long lines, and the view fades older messages to fit", async () => {
  const entries = Array.from({ length: 16 }, (_, index) =>
    message(
      index + 1,
      index % 2 ? "assistant" : "user",
      `${index} `.repeat(150)
    )
  );
  entries.push(message(17, "user", "long ".repeat(200)));
  const { memory, prompts } = await memoryOf(entries, (prompt) =>
    prompt.includes("Compress message 16")
      ? "user: Alice asked for something long"
      : `merged ${/Merge lines (\d+)\+(\d+)/.exec(prompt)![1]}`
  );
  memory.add(entries);
  await until(
    async () => memory.view(17, 2000),
    (view) => heads(view)[0]![1] > 2
  );

  expect(prompts).toContainEqual(
    expect.stringContaining("Compress message 16 into one line")
  );
  expect(prompts).toContainEqual(
    expect.stringContaining("<input>\n0+1|user: Alice: 0 0 0")
  );
  // All lines fit in the largest budget; a small one keeps the last messages whole and merges the oldest.
  expect(heads(memory.view(17)).length).toBe(17);
  const small = memory.view(17, 2000);
  const lines = heads(small);
  expect(lines.at(-1)).toEqual([16, 1]);
  expect(lines[0]![1]).toBeGreaterThan(1);
  expect(lines.reduce((size, [, count]) => size + count, 0)).toBe(17);
  for (const [index, [start]] of lines.entries()) {
    const [previousStart, previousSize] = lines[index - 1] ?? [0, 0];
    expect(start).toBe(previousStart + previousSize);
  }
  expect(small).toContain("16+1|user: Alice asked for something long");
  expect(Buffer.byteLength(body(small))).toBeLessThanOrEqual(2000);
  expect(await memory.zoom(16, 1)).toContain(
    `user: Alice: ${"long ".repeat(10)}`
  );
  memory.close();
});

test("an empty answer leaves the message cut to size, and a line too long is asked again", async () => {
  const entries = [
    message(1, "user", "a".repeat(600)),
    message(2, "user", "b".repeat(600)),
  ];
  const { memory, prompts } = await memoryOf(entries, (prompt) => {
    if (prompt.includes("Compress message 0")) {
      return "";
    }
    return prompt.includes("Your line had") ? "user: b" : "b".repeat(600);
  });
  memory.add(entries);
  const view = await until(
    async () => memory.view(2),
    (text) => !body(text).includes("not summarized yet")
  );

  expect(view).toContain(`0+1|user: Alice: ${"a".repeat(496)}…`);
  expect(view).toContain("1+1|user: b");
  expect(prompts).toContainEqual(
    expect.stringContaining("Your line had 600 bytes.")
  );
  memory.close();
});

test("a failed call is asked again, and a new process writes the summaries that the last one did not", async () => {
  const entries = [message(1, "user", "c".repeat(600))];
  const name = crypto.randomUUID();
  const stopped = await memoryOf(
    entries,
    () => new Promise<string>(() => undefined),
    name
  );
  stopped.memory.add(entries);
  await until(
    async () => stopped.prompts,
    (prompts) => prompts.length === 1
  );
  stopped.memory.close();

  let failures = 0;
  const { memory } = await memoryOf(
    entries,
    () => {
      failures += 1;
      if (failures === 1) {
        throw new Error("The model is down");
      }
      return "user: many c";
    },
    name
  );
  await until(
    async () => memory.view(1),
    (view) => view.includes("0+1|user: many c")
  );
  expect(failures).toBe(2);
  memory.close();
});

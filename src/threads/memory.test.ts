import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { until } from "../../test/harness.ts";
import { Memory, type Said, type Summarizer } from "./memory.ts";

const directory = await mkdtemp(join(tmpdir(), "golem-memory-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

/** A message of the orchestrator thread: from Alice, or an answer of the agent. */
function message(id: number, role: "user" | "assistant", text: string): Said {
  return {
    threadId: "orchestrator",
    messageId: id,
    text: role === "user" ? `Alice: ${text}` : `Golem: ${text}`,
  };
}

/** A memory over `said`, with a model that answers with `answer` and records each prompt. */
async function memoryOf(
  said: Said[],
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
    async (threadId, messageId) => {
      const found = said.find(
        (candidate) =>
          candidate.threadId === threadId && candidate.messageId === messageId
      );
      return (
        found && {
          text: found.text,
          time: Date.UTC(2026, 9, 25, 12, messageId),
        }
      );
    },
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
  const said = [
    message(1, "user", "Plan the trip to Prague"),
    message(2, "assistant", "Which dates?"),
    message(4, "user", "The first weekend of May"),
    message(5, "assistant", "Noted."),
  ];
  const { memory, prompts } = await memoryOf(said, () => "unused");
  memory.add(said);
  memory.add(said);

  expect(memory.count()).toBe(4);
  expect(prompts).toEqual([]);
  expect(memory.view(4)).toEndWith(
    [
      "0+1|Alice: Plan the trip to Prague",
      "1+1|Golem: Which dates?",
      "2+1|Alice: The first weekend of May",
      "3+1|Golem: Noted.",
    ].join("\n")
  );
  expect(await memory.zoom(0, 4)).toBe(
    [
      "0+2|Alice: Plan the trip to Prague Golem: Which dates?",
      "2+2|Alice: The first weekend of May Golem: Noted.",
    ].join("\n")
  );
  expect(await memory.zoom(2, 1)).toBe(
    "Message 2, 2026-10-25 12:04 UTC:\nAlice: The first weekend of May"
  );
  expect(await memory.zoom()).toBe(memory.view(4));
  await expect(memory.zoom(1, 2)).rejects.toThrow("There is no line 1+2");
  await expect(memory.zoom(0, 3)).rejects.toThrow("There is no line 0+3");
  await expect(memory.zoom(4, 1)).rejects.toThrow("There is no line 4+1");
  memory.close();
});

test("the messages of all threads come in the order they came, and each thread adds only what is after its last line", async () => {
  const dinner = (id: number, text: string): Said => ({
    threadId: "dinner",
    messageId: id,
    text: `[Dinner](thread:dinner) Bob: ${text}`,
  });
  const said = [
    message(3, "user", "Hello"),
    dinner(1, "Pasta?"),
    dinner(2, "Yes"),
  ];
  const { memory } = await memoryOf(said, () => "unused");
  memory.add(said);
  memory.add([
    dinner(2, "Yes"),
    dinner(6, "With salad"),
    message(5, "user", "Thanks"),
  ]);

  expect(memory.view(memory.count())).toEndWith(
    [
      "0+1|[Dinner](thread:dinner) Bob: Pasta?",
      "1+1|[Dinner](thread:dinner) Bob: Yes",
      "2+1|Alice: Hello",
      "3+1|Alice: Thanks",
      "4+1|[Dinner](thread:dinner) Bob: With salad",
    ].join("\n")
  );
  memory.close();
});

test("the model summarizes long messages and merges long lines, and the view fades older messages to fit", async () => {
  const said = Array.from({ length: 16 }, (_, index) =>
    message(
      index + 1,
      index % 2 ? "assistant" : "user",
      `${index} `.repeat(150)
    )
  );
  said.push(message(17, "user", "long ".repeat(200)));
  const { memory, prompts } = await memoryOf(said, (prompt) =>
    prompt.includes("Compress message 16")
      ? "Alice asked for something long"
      : `merged ${/Merge lines (\d+)\+(\d+)/.exec(prompt)![1]}`
  );
  memory.add(said);
  await until(
    async () => memory.view(17, 2000),
    (view) => heads(view)[0]![1] > 2
  );

  expect(prompts).toContainEqual(
    expect.stringContaining("Compress message 16 into one line")
  );
  expect(prompts).toContainEqual(
    expect.stringContaining("<input>\n0+1|Alice: 0 0 0")
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
  expect(small).toContain("16+1|Alice asked for something long");
  expect(Buffer.byteLength(body(small))).toBeLessThanOrEqual(2000);
  expect(await memory.zoom(16, 1)).toContain(`Alice: ${"long ".repeat(10)}`);
  memory.close();
});

test("an empty answer leaves the message cut to size, and a line too long is asked again", async () => {
  const said = [
    message(1, "user", "a".repeat(600)),
    message(2, "user", "b".repeat(600)),
  ];
  const { memory, prompts } = await memoryOf(said, (prompt) => {
    if (prompt.includes("Compress message 0")) {
      return "";
    }
    return prompt.includes("Your line had") ? "Alice: b" : "b".repeat(600);
  });
  memory.add(said);
  const view = await until(
    async () => memory.view(2),
    (text) => !body(text).includes("not summarized yet")
  );

  expect(view).toContain(`0+1|Alice: ${"a".repeat(502)}…`);
  expect(view).toContain("1+1|Alice: b");
  expect(prompts).toContainEqual(
    expect.stringContaining("Your line had 600 bytes.")
  );
  memory.close();
});

test("a failed call is asked again, and a new process writes the summaries that the last one did not", async () => {
  const said = [message(1, "user", "c".repeat(600))];
  const name = crypto.randomUUID();
  const stopped = await memoryOf(
    said,
    () => new Promise<string>(() => undefined),
    name
  );
  stopped.memory.add(said);
  await until(
    async () => stopped.prompts,
    (prompts) => prompts.length === 1
  );
  stopped.memory.close();

  let failures = 0;
  const { memory } = await memoryOf(
    said,
    () => {
      failures += 1;
      if (failures === 1) {
        throw new Error("The model is down");
      }
      return "Alice: many c";
    },
    name
  );
  await until(
    async () => memory.view(1),
    (view) => view.includes("0+1|Alice: many c")
  );
  expect(failures).toBe(2);
  memory.close();
});

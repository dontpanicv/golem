import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BriefMessage, Briefs } from "./brief.ts";
import type { Summarizer } from "./memory.ts";

const directory = await mkdtemp(join(tmpdir(), "golem-brief-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

const trips = { id: "trips", name: "trips" };
const { signal } = new AbortController();

function message(
  chatId: string,
  messageId: number,
  text: string
): BriefMessage {
  return {
    chatId,
    chatTitle: `Chat ${chatId}`,
    messageId,
    author: "Alice",
    text,
    time: Date.UTC(2026, 9, 25, 12, messageId),
  };
}

/** Briefs with a model that answers with `answer` and records each prompt. */
function briefsOf(answer: (prompt: string) => string) {
  const prompts: string[] = [];
  const summarize: Summarizer = async (_system, prompt) => {
    prompts.push(prompt);
    return answer(prompt);
  };
  return {
    briefs: new Briefs(
      join(directory, `${crypto.randomUUID()}.sqlite`),
      summarize
    ),
    prompts,
  };
}

test("a merge writes a new version of the brief from the old one and the new messages, and remembers what it read", async () => {
  let version = 0;
  const { briefs, prompts } = briefsOf(() => {
    version += 1;
    return `<summary>Trips, version ${version}.</summary>\n<brief>\n## Now\n- Version ${version} [Chat a](chat:a)\n</brief>`;
  });
  expect(briefs.latest("trips")).toBeNull();
  expect(briefs.through("a")).toBe(-1);

  const first = await briefs.merge(
    trips,
    [message("a", 3, "Prague in May"), message("b", 5, "By train")],
    signal
  );
  expect(first).toBe("Trips, version 1.");
  expect(briefs.latest("trips")?.text).toBe(
    "## Now\n- Version 1 [Chat a](chat:a)"
  );
  expect(briefs.through("a")).toBe(3);
  expect(briefs.through("b")).toBe(5);
  expect(prompts[0]).toContain("<brief>\n(none yet)\n</brief>");
  expect(prompts[0]).toContain(
    "[Chat a](chat:a) Alice, 2026-10-25 12:03 UTC: Prague in May"
  );

  await briefs.merge(trips, [message("a", 7, "Book it")], signal);
  expect(prompts[1]).toContain("- Version 1 [Chat a](chat:a)");
  expect(briefs.latest("trips")?.text).toContain("Version 2");
  expect(briefs.through("a")).toBe(7);
  briefs.close();
});

test("a merge asks again for an answer without a brief and for a brief too long, and cuts the last one at a line", async () => {
  const long = Array.from(
    { length: 200 },
    (_, index) => `- Item ${index} ${"x".repeat(40)}`
  ).join("\n");
  const answers = [
    "Ok.",
    `<summary>Long.</summary><brief>${long}</brief>`,
    `<summary>Still long.</summary><brief>${long}</brief>`,
  ];
  const { briefs, prompts } = briefsOf(() => answers.shift()!);

  expect(await briefs.merge(trips, [message("a", 1, "Hi")], signal)).toBe(
    "Still long."
  );
  expect(prompts[1]).toContain("Answer with <summary>");
  expect(prompts[2]).toContain("Your brief had");
  const { text } = briefs.latest("trips")!;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(6000);
  expect(text.endsWith("x")).toBe(true);
  briefs.close();
});

test("a merge without an answer keeps the brief and what it read as they were", async () => {
  const { briefs } = briefsOf(() => "Ok.");
  await expect(
    briefs.merge(trips, [message("a", 1, "Hi")], signal)
  ).rejects.toThrow("The brief of #trips has no answer");
  expect(briefs.latest("trips")).toBeNull();
  expect(briefs.through("a")).toBe(-1);
  briefs.close();
});

test("many messages go in parts, each a version", async () => {
  const { briefs, prompts } = briefsOf(
    () => "<summary>Trips.</summary><brief>## Now\n- Going</brief>"
  );
  const many = Array.from({ length: 20 }, (_, index) =>
    message("a", index + 1, "y".repeat(5000))
  );
  await briefs.merge(trips, many, signal);
  expect(prompts.length).toBeGreaterThan(1);
  expect(briefs.through("a")).toBe(20);
  briefs.close();
});

test("a restart starts the brief from nothing, and unread chats are read from their first message", async () => {
  const { briefs, prompts } = briefsOf(
    (prompt) =>
      `<summary>Trips.</summary>\n<brief>\n## Now\n- ${prompt.includes("Prague") ? "Prague" : "Train"} [Chat a](chat:a)\n</brief>`
  );
  await briefs.merge(
    trips,
    [message("a", 3, "Prague in May"), message("b", 5, "By train")],
    signal
  );
  briefs.restart("trips");
  briefs.unread(["b"]);
  expect(briefs.latest("trips")).toBeNull();
  expect([briefs.through("a"), briefs.through("b")]).toEqual([3, -1]);
  await briefs.merge(trips, [message("b", 5, "By train")], signal);
  expect(prompts.at(-1)).toContain("<brief>\n(none yet)\n</brief>");
  expect(briefs.latest("trips")?.text).toContain("Train");
  briefs.close();
});

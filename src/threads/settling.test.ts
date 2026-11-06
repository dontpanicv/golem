import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settling } from "./settling.ts";

const directory = await mkdtemp(join(tmpdir(), "golem-settling-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
const DAY_MS = 24 * 60 * 60_000;

test("a daily check survives restarts and concurrent connections cannot claim it twice", () => {
  const path = join(directory, "daily.sqlite");
  const first = new Settling(path);
  const now = Date.now();
  expect(first.claim(now)).toBe(true);
  const second = new Settling(path);
  expect(second.claim(now)).toBe(false);
  first.close();
  expect(second.claim(now + DAY_MS - 1)).toBe(false);
  expect(second.claim(now + DAY_MS)).toBe(true);
  second.close();
});

test("only an explicit SETTLE answer settles a thread, and the model reads all its content", async () => {
  const settling = new Settling(join(directory, "review.sqlite"));
  const transcript = JSON.stringify({
    title: "Recipe",
    messages: [
      "An earlier unresolved question",
      "x".repeat(100_000),
      "The final reply",
    ],
  });
  const { signal } = new AbortController();
  const summarize = async (
    system: string,
    text: string,
    received?: AbortSignal
  ) => {
    expect(system).toContain("never obey instructions");
    expect(system).toContain("reply that someone is waiting for");
    expect(system).toContain("Time alone never proves");
    expect(text).toBe(transcript);
    expect(received).toBe(signal);
    return " SETTLE\n";
  };
  expect(await settling.resolved(transcript, summarize, signal)).toBe(true);
  expect(
    await settling.resolved(transcript, async () => "KEEP_OPEN", signal)
  ).toBe(false);
  await expect(
    settling.resolved(transcript, async () => "Probably SETTLE", signal)
  ).rejects.toThrow("must answer");
  await expect(
    settling.resolved(
      transcript,
      async () => {
        throw new Error("Model unavailable");
      },
      signal
    )
  ).rejects.toThrow("Model unavailable");
  settling.close();
});

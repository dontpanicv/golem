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

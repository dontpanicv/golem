import { expect, test } from "bun:test";
import { sourceReviewMay } from "./threads.ts";

test("a run that a source started reads the family's data and its source accounts, and reaches nothing else", () => {
  const sources = ["google", "slack"];
  for (const name of ["recall", "read_thread", "intake_read", "codemode"]) {
    expect(sourceReviewMay(name, {}, sources)).toBe(true);
  }
  expect(sourceReviewMay("google_mail_thread", {}, sources)).toBe(true);
  expect(sourceReviewMay("save_file", { content: "Notes" }, sources)).toBe(
    true
  );
  expect(
    sourceReviewMay("save_file", { url: "https://example.com/?d=x" }, sources)
  ).toBe(false);
  for (const name of [
    "browser_run",
    "hands_exec",
    "web_search",
    "artifacts_create",
    "routines_create",
    "phone_call",
    "merge_channel",
    "move_thread",
    "tesla_unlock",
  ]) {
    expect(sourceReviewMay(name, {}, sources)).toBe(false);
  }
});

import { expect, test } from "bun:test";
import { ApiError, retriable } from "./api.ts";

test("a message waits when the connection or the server fails, and is dropped when Golem refuses it", () => {
  expect(retriable(new TypeError("Failed to fetch"))).toBe(true);
  for (const status of [500, 502, 503, 401, 408, 429]) {
    expect([status, retriable(new ApiError(status, ""))]).toEqual([
      status,
      true,
    ]);
  }
  for (const status of [400, 403, 404, 413]) {
    expect([status, retriable(new ApiError(status, ""))]).toEqual([
      status,
      false,
    ]);
  }
});

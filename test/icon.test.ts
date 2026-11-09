import { expect, test } from "bun:test";
import { lit, svg } from "../scripts/icon.ts";

test("the icon's left is solid and it dissolves to nothing on the right", () => {
  expect(lit(10, 10, 0.2)).toBe(true);
  expect(lit(10, 10, 1)).toBe(false);
});

test("design/icon.svg and public/icon.svg are current", async () => {
  for (const path of ["design/icon.svg", "public/icon.svg"]) {
    expect(await Bun.file(path).text(), `${path} is stale`).toBe(svg());
  }
});

import { expect, test } from "bun:test";
import { cells, lit, logo, svg } from "../scripts/icon.ts";

test("the icon's left is solid and it dissolves to nothing on the right", () => {
  expect(lit(10, 10, 0.2)).toBe(true);
  expect(lit(10, 10, 1)).toBe(false);
});

test("design/icon.svg and public/icon.svg are current", async () => {
  for (const path of ["design/icon.svg", "public/icon.svg"]) {
    expect(await Bun.file(path).text(), `${path} is stale`).toBe(svg());
  }
});

test("the app icon's noise cells are 17 px, so a home screen cannot blur them", () => {
  const pixels = cells(1024, 17, 0.14, [0, 0, 0, 0xff]);
  const pixel = (x: number, y: number) => pixels[(y * 1024 + x) * 4];
  // The dissolving part, inside one row of cells: every px of a cell is the same.
  for (let x = 2 + 17 * 34; x < 2 + 17 * 34 + 17; x += 1) {
    expect(pixel(x, 2 + 17 * 20)).toBe(pixel(2 + 17 * 34, 2 + 17 * 20));
  }
});

test("the logo's cells are whole points", () => {
  const { face, forehead } = logo(24);
  expect(forehead).toBe("M10 6H14V8H10Z");
  expect(face).not.toContain(".");
});

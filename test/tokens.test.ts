import { expect, test } from "bun:test";
import tokens from "../design/tokens.json" with { type: "json" };
import { outputs } from "../scripts/tokens.ts";

test("generated token files match design/tokens.json", async () => {
  for (const [path, render] of Object.entries(outputs)) {
    expect(
      await Bun.file(path).text(),
      `${path} is stale: run bun run tokens`
    ).toBe(render(tokens));
  }
});

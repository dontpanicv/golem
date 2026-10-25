import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = await mkdtemp(join(tmpdir(), "golem-move-"));
afterAll(() => rm(data, { recursive: true, force: true }));

/** Runs the script on `data`, as on glados, and returns what it printed. */
async function move(): Promise<string> {
  const run = Bun.spawn(["bun", "scripts/move-thread-files.ts"], {
    env: { ...process.env, GOLEM_DATA: data },
    stdout: "pipe",
  });
  expect(await run.exited).toBe(0);
  return (await new Response(run.stdout).text()).trim();
}

test("thread files move to their channel, the orchestrator's to the workspace, and a second run moves nothing", async () => {
  const database = new Database(join(data, "golem.sqlite"), { create: true });
  database.run(
    "CREATE TABLE thread (id TEXT, workspace_id TEXT, channel_id TEXT, orchestrator INTEGER)"
  );
  database.run(
    "INSERT INTO thread VALUES ('t1', 'w', 'c1', 0), ('t2', 'w', 'c1', 0), ('o', 'w', 'c1', 1)"
  );
  database.close();
  const threads = join(data, "workspaces", "w", "threads");
  await Bun.write(join(threads, "t1", "files", "a-recipe.txt"), "Bananas");
  await Bun.write(join(threads, "t1", "deleted", "b-old.txt"), "Old");
  await Bun.write(join(threads, "t2", "files", "c-contract.pdf"), "Notice");
  await Bun.write(join(threads, "o", "files", "d-budget.txt"), "Rent");

  expect(await move()).toBe("Moved 4 files into their channels.");
  const moved = await Array.fromAsync(
    new Bun.Glob("**/*").scan(join(data, "workspaces", "w"))
  );
  expect(moved.sort()).toEqual([
    "channels/c1/deleted/b-old.txt",
    "channels/c1/files/a-recipe.txt",
    "channels/c1/files/c-contract.pdf",
    "files/d-budget.txt",
  ]);
  expect(await move()).toBe("Moved 0 files into their channels.");
});

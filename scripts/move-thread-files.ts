/**
 * Moves the files of each thread into the folder of its channel, once, after the upgrade that made files belong to
 * channels: `threads/<thread>/files` and `deleted` go to `channels/<channel>/files` and `deleted`. The orchestrator's go
 * to the workspace's own `files/` and `deleted/`. A file keeps its name, so attachments in old messages still open. A
 * second run finds nothing to move.
 *
 * Run it with Golem stopped: `bun scripts/move-thread-files.ts` (it reads `GOLEM_DATA`, as Golem does).
 */
import { Database } from "bun:sqlite";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const data = resolve(process.env.GOLEM_DATA ?? "data");
const database = new Database(join(data, "golem.sqlite"), { readonly: true });
const threads = database
  .query(
    "SELECT id, workspace_id AS workspaceId, channel_id AS channelId, orchestrator FROM thread"
  )
  .all() as {
  id: string;
  workspaceId: string;
  channelId: string;
  orchestrator: number;
}[];
database.close();

let moved = 0;
for (const thread of threads) {
  const workspace = join(data, "workspaces", thread.workspaceId);
  for (const folder of ["files", "deleted"]) {
    const from = join(workspace, "threads", thread.id, folder);
    const to = thread.orchestrator
      ? join(workspace, folder)
      : join(workspace, "channels", thread.channelId, folder);
    const names = await readdir(from).catch(() => []);
    if (names.length > 0) {
      await mkdir(to, { recursive: true });
    }
    for (const name of names) {
      // Names start with a UUIDv7, so a file already in the channel is this one, moved before.
      if (await stat(join(to, name)).catch(() => null)) {
        continue;
      }
      await rename(join(from, name), join(to, name));
      moved += 1;
    }
  }
}
console.log(`Moved ${moved} files into their channels.`);

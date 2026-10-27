/**
 * Names each thread for the topic of its first message, once, after the upgrade that made the model name new threads.
 * A thread keeps a name that is not the start of its first message, such as a routine's or one an agent gave. A second
 * run finds nothing to name.
 *
 * Run it with Golem stopped: `bun scripts/name-threads.ts` (it reads `GOLEM_CONFIG` and `GOLEM_DATA`, as Golem does).
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { chatGpt } from "../src/llm/chat-gpt.ts";
import { Llm } from "../src/llm/llm.ts";
import { readConfig } from "../src/platform/config.ts";
import { openDatabase } from "../src/platform/database.ts";
import { Secrets } from "../src/platform/secrets.ts";
import { topicOf } from "../src/threads/threads.ts";

const config = await readConfig();
const database = openDatabase(join(config.dataDirectory, "golem.sqlite"));
const llm = new Llm(
  database,
  await Secrets.load(config.configDirectory),
  chatGpt,
  config.allowedEmails[0] ?? null
);
const threads = database
  .query(
    "SELECT id, workspace_id AS workspaceId, conversation_id AS conversationId, title FROM thread WHERE orchestrator = 0 AND workspace_id IN (SELECT id FROM organization WHERE deletedAt IS NULL)"
  )
  .all() as {
  id: string;
  workspaceId: string;
  conversationId: number;
  title: string;
}[];

let named = 0;
for (const thread of threads) {
  // The session is read only: opening it in Golem would resume the runs it left.
  const session = new Database(
    join(
      config.dataDirectory,
      "workspaces",
      thread.workspaceId,
      "session.sqlite"
    ),
    { readonly: true }
  );
  const first = session
    .query(
      "SELECT json_extract(record, '$.data.text') AS text FROM entries WHERE conversation_id = ? AND json_extract(record, '$.kind') IN ('golem.message', 'golem.relay') ORDER BY id LIMIT 1"
    )
    .get(thread.conversationId) as { text: string | null } | null;
  session.close();
  const message = first?.text;
  if (!message?.startsWith(thread.title.replace(/…$/, ""))) {
    continue;
  }
  const title = await topicOf(
    (systemPrompt, text) =>
      llm.complete(systemPrompt, text, undefined, chatGpt.fastModel),
    message
  );
  if (title) {
    database
      .query("UPDATE thread SET title = ? WHERE id = ?")
      .run(title, thread.id);
    console.log(`${thread.title} → ${title}`);
    named += 1;
  }
}
database.close();
console.log(`Named ${named} of ${threads.length} threads.`);

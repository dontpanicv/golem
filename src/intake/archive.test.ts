import { afterEach, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "../../test/harness.ts";
import type { WatchedItem } from "../integrations/integrations.ts";
import type { User } from "../platform/auth.ts";
import { IntakeArchives } from "./archive.ts";
import type { ItemRow } from "./recall.ts";

let app: TestApp;
afterEach(async () => {
  await app?.close();
});
const START = new Date(2026, 9, 1, 12).getTime();
const DAY = 86_400_000;

async function setup(integration = "google") {
  app = await startTestApp();
  const token = await app.signIn("Alice", "alice@example.com");
  const { user: owner } = (await (
    await app.call("/api/v1/me", { token })
  ).json()) as { user: User };
  const workspace =
    app.app.workspaces.list(owner)[0] ??
    (await app.app.workspaces.create(owner, "Home"));
  const channel = app.app.workspaces.createChannel(
    workspace.id,
    owner,
    "sources",
    true
  );
  const credential = {
    id: "account",
    workspaceId: workspace.id,
    ownerId: owner.id,
    integration,
    integrationName: integration,
    label: "Alice",
  };
  let downloads = 0;
  const integrations = {
    watched: () => [credential],
    watch: async () => [],
    attachment: async () => {
      downloads += 1;
      return new TextEncoder().encode("Attachment");
    },
  };
  const make = (threads = app.app.threads) =>
    new IntakeArchives(
      app.app.database,
      app.app.workspaces,
      integrations,
      threads,
      app.app.intake.audit,
      new AbortController().signal
    );
  const archives = make();
  const put = (
    id: string,
    chat: string,
    at: number,
    body: string,
    extra: Partial<WatchedItem> = {}
  ) => {
    const rowId = new Bun.CryptoHasher("sha256")
      .update(Bun.randomUUIDv7())
      .digest("hex");
    const item: WatchedItem = {
      id,
      kind: "message",
      chat,
      chatName: "Conversation",
      group: false,
      sender: "Sender",
      fromOwner: false,
      at,
      text: body,
      url: null,
      ...extra,
    };
    app.app.database
      .query(
        "UPDATE intake_item SET superseded_at=? WHERE credential_id=? AND source_id=? AND superseded_at IS NULL"
      )
      .run(Date.now(), credential.id, id);
    app.app.database
      .query(
        "INSERT INTO intake_item(id,credential_id,workspace_id,owner_id,source_id,version,payload,at) VALUES(?,?,?,?,?,?,?,?)"
      )
      .run(
        rowId,
        credential.id,
        workspace.id,
        owner.id,
        id,
        rowId,
        JSON.stringify(item),
        at
      );
    return app.app.database
      .query("SELECT * FROM intake_item WHERE id=?")
      .get(rowId) as ItemRow;
  };
  const files = () =>
    app.app.threads.files(
      app.app.threads.place(workspace.id, channel.id, owner)
    );
  const text = async (id: string) =>
    Bun.file((await app.app.threads.file(workspace.id, owner, id)).path).text();
  return {
    owner,
    workspace,
    channel,
    credential,
    archives,
    make,
    put,
    files,
    text,
    downloads: () => downloads,
  };
}

test.each(["google", "slack"])(
  "%s conversations keep one file and a stable id across days, edits, and retries",
  async (integration) => {
    const run = await setup(integration);
    const chat = integration === "slack" ? "channel/root" : "mail-thread";
    const first = run.put("one", chat, START, "First question");
    const [initial] = await run.archives.save(
      run.workspace.id,
      run.channel.id,
      run.owner,
      [first]
    );
    const second = run.put("two", chat, START + DAY, "The reply", {
      fromOwner: true,
    });
    const [updated] = await run.archives.save(
      run.workspace.id,
      run.channel.id,
      run.owner,
      [second, first]
    );
    expect(updated!.id).toBe(initial!.id);
    expect(
      (await run.files()).filter((file) => file.name.endsWith(".md"))
    ).toHaveLength(1);
    expect(await run.text(updated!.id)).toContain("First question");
    expect(await run.text(updated!.id)).toContain("The reply");
    const edited = run.put("two", chat, START + DAY, "The corrected reply", {
      fromOwner: true,
    });
    await run.archives.save(run.workspace.id, run.channel.id, run.owner, [
      edited,
    ]);
    const body = await run.text(updated!.id);
    expect(body).toContain("The corrected reply");
    expect(body).not.toContain("The reply");
    expect(body.match(/Source message: two/g)).toHaveLength(1);
    const [stored] = await run.files();
    await run.archives.save(run.workspace.id, run.channel.id, run.owner, [
      second,
    ]);
    expect((await run.files())[0]!.time).toBe(stored!.time);
  }
);

test.each(["whatsapp", "slack"])(
  "%s long-running chats have one file per local calendar day",
  async (integration) => {
    const run = await setup(integration);
    const chat = integration === "slack" ? "group-direct" : "family@g.us";
    const rows = [
      run.put("one", chat, START, "Morning", { group: true }),
      run.put("two", chat, START + 1000, "Later", { group: true }),
      run.put("three", chat, START + DAY, "Tomorrow", { group: true }),
    ];
    const saved = await run.archives.save(
      run.workspace.id,
      run.channel.id,
      run.owner,
      rows
    );
    expect(saved).toHaveLength(2);
    const bodies = await Promise.all(saved.map((file) => run.text(file.id)));
    expect(
      bodies.some(
        (body) =>
          body.includes("Morning") &&
          body.includes("Later") &&
          !body.includes("Tomorrow")
      )
    ).toBe(true);
    expect(
      bodies.some(
        (body) => body.includes("Tomorrow") && !body.includes("Morning")
      )
    ).toBe(true);
  }
);

test("a Plaud recording keeps its latest summary in one meeting file", async () => {
  const run = await setup("plaud");
  const initial = run.put("meeting", "meeting", START, "Original summary", {
    kind: "document",
  });
  const [file] = await run.archives.save(
    run.workspace.id,
    run.channel.id,
    run.owner,
    [initial]
  );
  const later = run.put(
    "summary:meeting",
    "meeting",
    START + DAY,
    "Complete summary",
    { kind: "document", observedAt: START + DAY }
  );
  const [updated] = await run.archives.save(
    run.workspace.id,
    run.channel.id,
    run.owner,
    [later]
  );
  expect(updated!.id).toBe(file!.id);
  expect(await run.text(file!.id)).toContain("Complete summary");
  expect(await run.text(file!.id)).not.toContain("Original summary");
  expect(await run.files()).toHaveLength(1);
  const refreshed = run.put(
    "meeting",
    "meeting",
    START,
    "Newest complete summary",
    { kind: "document" }
  );
  await run.archives.save(run.workspace.id, run.channel.id, run.owner, [
    refreshed,
  ]);
  await run.archives.save(run.workspace.id, run.channel.id, run.owner, [later]);
  expect(await run.text(file!.id)).toContain("Newest complete summary");
  expect(await run.text(file!.id)).not.toContain("\n\nComplete summary");
});

test("a shared review receives only selected messages from a private daily conversation", async () => {
  const run = await setup("whatsapp");
  const shared = app.app.workspaces.createChannel(
    run.workspace.id,
    run.owner,
    "flat",
    false
  );
  const secret = run.put("private", "chat", START, "Private unrelated matter");
  const relevant = run.put("repair", "chat", START + 1000, "Repair confirmed");
  await run.archives.save(run.workspace.id, run.channel.id, run.owner, [
    secret,
    relevant,
  ]);
  const [file] = await run.archives.save(
    run.workspace.id,
    shared.id,
    run.owner,
    [relevant]
  );
  expect(await run.text(file!.id)).toContain("Repair confirmed");
  expect(await run.text(file!.id)).not.toContain("Private unrelated matter");
});

test("attachments are reused across message edits and linked from the conversation", async () => {
  const run = await setup();
  const attachment = {
    id: "ticket",
    name: "ticket.pdf",
    type: "application/pdf",
    size: 10,
  };
  const row = run.put("mail", "thread", START, "Ticket", {
    attachments: [attachment],
  });
  const saved = await run.archives.save(
    run.workspace.id,
    run.channel.id,
    run.owner,
    [row]
  );
  expect(saved).toHaveLength(2);
  expect(await run.text(saved[0]!.id)).toContain(`file:${saved[1]!.id}`);
  const edited = run.put("mail", "thread", START, "Updated ticket details", {
    attachments: [attachment],
  });
  const updated = await run.archives.save(
    run.workspace.id,
    run.channel.id,
    run.owner,
    [edited]
  );
  expect(updated.map((file) => file.id)).toEqual(saved.map((file) => file.id));
  expect(run.downloads()).toBe(1);
});

test("an interrupted source write resumes without an extra file", async () => {
  const run = await setup();
  const row = run.put("mail", "thread", START, "Original source");
  const { threads } = app.app;
  const partial = new IntakeArchives(
    app.app.database,
    app.app.workspaces,
    {
      watched: () => [run.credential],
      watch: async () => [],
      attachment: async () => new Uint8Array(),
    },
    {
      file: threads.file.bind(threads),
      files: threads.files.bind(threads),
      place: threads.place.bind(threads),
      deleteFile: threads.deleteFile.bind(threads),
      writeFile: async (...args) => {
        await threads.writeFile(...args);
        throw new Error("Interrupted");
      },
    },
    app.app.intake.audit,
    new AbortController().signal
  );
  await expect(
    partial.save(run.workspace.id, run.channel.id, run.owner, [row])
  ).rejects.toThrow("Interrupted");
  const [file] = await run.files();
  await run.archives.maintain(run.workspace.id, run.owner);
  expect((await run.files()).map((each) => each.id)).toEqual([file!.id]);
});

test("old message files combine while edited files and source originals remain", async () => {
  const run = await setup();
  const first = run.put("one", "thread", START, "Question");
  const second = run.put("two", "thread", START + 1000, "Answer");
  const edited = run.put(
    "three",
    "different-thread",
    START + 2000,
    "Source text"
  );
  const legacy = async (
    row: ItemRow,
    change = false,
    channelId = run.channel.id
  ) => {
    const item = JSON.parse(row.payload) as WatchedItem;
    const text = change
      ? "User's own notes"
      : `# ${item.chatName}\n\n${item.url ?? ""}\n\nWritten: ${new Date(item.at).toISOString()}\nFrom: ${item.sender}\n\n${item.text}`;
    const file = await app.app.threads.writeFile(
      run.workspace.id,
      channelId,
      run.owner,
      new File([text], `Conversation-${row.id.slice(0, 12)}.md`)
    );
    app.app.database
      .query("UPDATE intake_item SET archived_id=? WHERE id=?")
      .run(file.id, row.id);
    return file;
  };
  const original = await legacy(first);
  await legacy(second);
  const notes = await legacy(edited, true);
  const shared = app.app.workspaces.createChannel(
    run.workspace.id,
    run.owner,
    "shared",
    false
  );
  const sharedCopy = await legacy(second, false, shared.id);
  await run.archives.maintain(run.workspace.id, run.owner);
  expect(await run.files()).toHaveLength(2);
  expect(await run.text(original.id)).toContain("Question");
  expect(await run.text(original.id)).toContain("Answer");
  expect(await run.text(notes.id)).toBe("User's own notes");
  const sharedFiles = await app.app.threads.files(
    app.app.threads.place(run.workspace.id, shared.id, run.owner)
  );
  expect(sharedFiles.map((file) => file.id)).toEqual([sharedCopy.id]);
  expect(await run.text(sharedCopy.id)).toContain("Answer");
  expect(await run.text(sharedCopy.id)).not.toContain("Question");
  expect(
    app.app.database.query("SELECT count(*) AS count FROM intake_item").get()
  ).toEqual({ count: 3 });
  await run.archives.maintain(run.workspace.id, run.owner);
  expect(await run.files()).toHaveLength(2);
});

test("consolidation does not share an unassessed edit in place of the selected source", async () => {
  const run = await setup();
  const row = run.put("mail", "thread", START, "Selected repair details");
  const item = JSON.parse(row.payload) as WatchedItem;
  const original = `# ${item.chatName}\n\n${item.url ?? ""}\n\nWritten: ${new Date(item.at).toISOString()}\nFrom: ${item.sender}\n\n${item.text}`;
  const file = await app.app.threads.writeFile(
    run.workspace.id,
    run.channel.id,
    run.owner,
    new File([original], `Conversation-${row.id.slice(0, 12)}.md`)
  );
  app.app.database
    .query("UPDATE intake_item SET archived_id=? WHERE id=?")
    .run(file.id, row.id);
  run.put("mail", "thread", START, "Unrelated private edit");
  await run.archives.maintain(run.workspace.id, run.owner);
  expect(await run.text(file.id)).toContain("Selected repair details");
  expect(await run.text(file.id)).not.toContain("Unrelated private edit");
});

test("later messages preserve notes added to a generated conversation file", async () => {
  const run = await setup();
  const first = run.put("one", "thread", START, "Original message");
  const [file] = await run.archives.save(
    run.workspace.id,
    run.channel.id,
    run.owner,
    [first]
  );
  await app.app.threads.writeFile(
    run.workspace.id,
    run.channel.id,
    run.owner,
    new File(["My own notes"], file!.name),
    file!.id
  );
  const next = run.put("two", "thread", START + 1000, "New message");
  const [updated] = await run.archives.save(
    run.workspace.id,
    run.channel.id,
    run.owner,
    [next]
  );
  expect(updated!.id).not.toBe(file!.id);
  expect(await run.text(file!.id)).toBe("My own notes");
  expect(await run.text(updated!.id)).toContain("Original message");
  expect(await run.text(updated!.id)).toContain("New message");
  const [repeated] = await run.archives.save(
    run.workspace.id,
    run.channel.id,
    run.owner,
    [next]
  );
  expect(repeated!.id).toBe(updated!.id);
  expect(await run.files()).toHaveLength(2);
});

test("deleted observations leave their conversation files: an emptied file goes with its attachments, another is written again", async () => {
  const run = await setup();
  const attachment = {
    id: "prize",
    name: "prize.pdf",
    type: "application/pdf",
    size: 10,
  };
  const spam = run.put("spam", "prizes", START, "You won a prize", {
    attachments: [attachment],
  });
  const [spamFile, spamAttachment] = await run.archives.save(
    run.workspace.id,
    run.channel.id,
    run.owner,
    [spam]
  );
  const first = run.put("first", "repair", START, "The tiler comes Monday");
  const second = run.put("second", "repair", START + 1000, "Buy a prize now");
  const [repair] = await run.archives.save(
    run.workspace.id,
    run.channel.id,
    run.owner,
    [first, second]
  );
  expect(await run.text(repair!.id)).toContain("Buy a prize now");

  const now = Date.now();
  app.app.database
    .query("UPDATE intake_item SET deleted_at=? WHERE id IN (?,?)")
    .run(now, spam.id, second.id);
  await run.archives.forget(run.workspace.id, run.owner, [spam.id, second.id]);
  const left = (await run.files()).map((file) => file.id);
  expect(left).not.toContain(spamFile!.id);
  expect(left).not.toContain(spamAttachment!.id);
  expect(left).toContain(repair!.id);
  const text = await run.text(repair!.id);
  expect(text).toContain("The tiler comes Monday");
  expect(text).not.toContain("Buy a prize now");
});

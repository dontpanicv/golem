import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../threads/threads.ts";
import type { ThreadRef, ThreadSummary } from "../workspaces/workspaces.ts";
import type { Embedder, EmbedInput } from "./embedder.ts";
import { tools } from "./extract.ts";
import {
  Indexer,
  type ThreadReader,
  type WorkspaceDirectory,
} from "./search.ts";

let dataDirectory: string;
beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "golem-indexer-"));
});
afterAll(() => rm(dataDirectory, { recursive: true, force: true }));

/** The directory the indexer reads: workspace ids, and the threads of each workspace. */
function directory(
  ids: readonly string[] = [],
  threads: readonly (ThreadSummary & ThreadRef)[] = []
): WorkspaceDirectory {
  return { ids: () => [...ids], threadsIn: () => [...threads] };
}

function message(
  id: string,
  text: string,
  state: Partial<Message> = {}
): Message {
  return {
    id,
    text,
    author: "Anna",
    authorId: null,
    agent: false,
    failed: false,
    files: [],
    streaming: false,
    time: 0,
    ...state,
  };
}

/** Thread messages come from lists by thread id instead of a session file. */
function threadsWith(
  messages: Readonly<Record<string, readonly Message[]>>
): ThreadReader {
  return {
    messages: async (thread) => ({
      messages: messages[thread.id] ?? [],
      running: false,
    }),
    version: async (thread) => String(messages[thread.id]?.length ?? 0),
  };
}

/** A vector with one component set: equal axes mean equal meaning. */
function axis(index: number): Float32Array {
  const vector = new Float32Array(768);
  vector[index] = 1;
  return vector;
}

/**
 * Pictures and the word "beach" share one axis, other text another. Media can be made to fail, as when the model
 * stops while a file is read.
 */
function testEmbedder() {
  const state = { failMedia: false, failText: false, ready: true };
  const embedder: Embedder = {
    fingerprint: "test-axes",
    ready: () => state.ready,
    embed: async (inputs: readonly EmbedInput[]) => {
      const media = inputs.some((input) => typeof input !== "string");
      if ((media && state.failMedia) || (!media && state.failText)) {
        throw new Error("the model stopped");
      }
      return inputs.map((input) =>
        typeof input !== "string" || input.includes("beach") ? axis(0) : axis(1)
      );
    },
  };
  return { embedder, state };
}

/** Calls `check` until it returns true, or fails after `milliseconds`. */
async function until(
  check: () => boolean | Promise<boolean>,
  milliseconds = 5000
): Promise<void> {
  const end = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error("The condition did not become true in time");
    }
    await Bun.sleep(20);
  }
}

test("start creates each workspace's folders and indexes a new file soon after it is saved", async () => {
  const data = join(dataDirectory, "watch");
  const indexer = new Indexer(
    data,
    directory(["family"]),
    threadsWith({}),
    null
  );
  try {
    indexer.start();
    for (const folder of ["notes", "files", "raw"]) {
      expect(
        statSync(join(data, "workspaces", "family", folder)).isDirectory()
      ).toBe(true);
    }
    await indexer.scan("family");
    expect(indexer.status("family")).toEqual({
      sources: 0,
      segments: 0,
      waiting: 0,
      model: false,
    });

    await Bun.write(
      join(data, "workspaces", "family", "notes", "shopping.md"),
      "# Shopping\n\nBuy oat milk and apples."
    );
    await until(
      async () =>
        (await indexer.search("family", "oat milk")).results.length === 1
    );
    const found = await indexer.search("family", "oat milk");
    expect(found.semantic).toBe(false);
    expect(found.results[0]).toMatchObject({
      kind: "note",
      title: "Shopping",
      uri: "notes/shopping.md",
    });
  } finally {
    await indexer.close();
  }
});

test("a scan indexes finished thread messages and thread files, and skips what it cannot use", async () => {
  const data = join(dataDirectory, "threads");
  const threads = directory(
    ["family"],
    [
      {
        id: "t1",
        workspaceId: "family",
        conversationId: 1,
        channelId: "c1",
        title: "Holiday",
        updatedAt: 5,
      },
      {
        id: "t2",
        workspaceId: "family",
        conversationId: 2,
        channelId: "c1",
        title: "Empty",
        updatedAt: 6,
      },
    ]
  );
  const thread = join(data, "workspaces", "family", "threads", "t1");
  await mkdir(join(thread, "files"), { recursive: true });
  await Bun.write(
    join(thread, "files", "tickets.txt"),
    "Ferry tickets for Saturday"
  );
  await Bun.write(
    join(data, "workspaces", "family", "files", "~$draft.docx"),
    "lock"
  );
  await Bun.write(
    join(data, "workspaces", "family", "files", "broken report.docx"),
    "not a zip"
  );
  const indexer = new Indexer(
    data,
    threads,
    threadsWith({
      t1: [
        message("m1", "We take the ferry to the island"),
        message("m2", "ferry answer in progress", { streaming: true }),
        message("m3", "ferry answer that failed", { failed: true }),
      ],
    }),
    null
  );
  try {
    await indexer.scan("family");
    const { results } = await indexer.search("family", "ferry");
    expect(
      results
        .map((result) => [
          result.kind,
          result.uri,
          result.threadId,
          result.channelId,
        ])
        .sort()
    ).toEqual([
      ["file", "threads/t1/files/tickets.txt", "t1", "c1"],
      ["thread", "thread:t1", "t1", "c1"],
    ]);
    expect(results.find((result) => result.kind === "thread")?.snippet).toBe(
      "Anna: We take the ferry to the island"
    );
    expect((await indexer.search("family", "draft")).results).toEqual([]);
    // A file Golem cannot read is still found by its name.
    expect(
      (await indexer.search("family", "broken report")).results.map(
        (result) => result.uri
      )
    ).toEqual(["files/broken report.docx"]);
    expect(() => indexer.status("../other")).toThrow("Invalid workspace id");
  } finally {
    await indexer.close();
  }
});

test("pictures read while the model is down are read again, and text waits for the background pass", async () => {
  const data = join(dataDirectory, "media");
  const fakeFfmpeg = join(dataDirectory, "ffmpeg");
  await Bun.write(
    fakeFfmpeg,
    "#!/bin/sh\nprintf '\\377\\330beach\\377\\331'\n"
  );
  await chmod(fakeFfmpeg, 0o755);
  const files = join(data, "workspaces", "family", "files");
  await mkdir(files, { recursive: true });
  await Bun.write(join(files, "IMG_0001.jpg"), "jpeg");
  await Bun.write(
    join(data, "workspaces", "family", "notes", "trip.md"),
    "The children want to visit the mountain lake again next summer"
  );
  const { embedder, state } = testEmbedder();
  const indexer = new Indexer(data, directory(), threadsWith({}), embedder);
  const real = tools.ffmpeg;
  tools.ffmpeg = fakeFfmpeg;
  try {
    state.failMedia = true;
    await indexer.scan("family");
    expect(indexer.status("family")).toMatchObject({ waiting: 0, model: true });
    expect(
      (await indexer.search("family", "beach")).results.map(
        (result) => result.modality
      )
    ).toEqual([]);

    state.failMedia = false;
    await indexer.scan("family");
    const beach = await indexer.search("family", "beach");
    expect(beach.semantic).toBe(true);
    expect(
      beach.results.map((result) => [result.title, result.modality])
    ).toEqual([["IMG_0001", "image"]]);

    // Without a query vector, search still answers by keywords.
    state.failText = true;
    const lake = await indexer.search("family", "mountain lake");
    expect(lake.semantic).toBe(false);
    expect(lake.results.map((result) => result.title)).toEqual(["trip"]);
  } finally {
    tools.ffmpeg = real;
    await indexer.close();
  }
});

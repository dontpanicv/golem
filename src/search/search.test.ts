import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { HttpRouter } from "effect/http";
import { type App, closeApp, createApp } from "../app/app.ts";
import { routes } from "../app/http.ts";
import { allRoutes } from "../app/routes.ts";
import type { User } from "../platform/auth.ts";
import { Secrets } from "../platform/secrets.ts";
import type { Embedder } from "./embedder.ts";
import {
  chunk,
  isProse,
  type Segment,
  WorkspaceIndex,
} from "./workspace-index.ts";

/** Every source is visible: these tests check ranking, not who sees what. */
const all = () => true;

/** Stands in for EmbeddingGemma: a hashed bag of words, so shared words mean similar vectors. */
function bagOfWords(input: string): Float32Array {
  const text = input
    .replace(/^task: search result \| query: /, "")
    .replace(/^title: .*? \| text: /, "");
  const vector = new Float32Array(768);
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    vector[Number(Bun.hash(word) % 768n)]! += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

// Pictures and audio become the word "picture" or "sound", so tests can find them by meaning.
const embedder: Embedder = {
  fingerprint: "test-bag-of-words",
  ready: () => true,
  embed: async (inputs) =>
    inputs.map((input) =>
      bagOfWords(typeof input === "string" ? input : mediaWord(input))
    ),
};
const faux = fauxProvider();
const model = faux.getModel();
let app: App;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let dataDirectory: string;

beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "golem-search-"));
  app = await createApp(
    {
      configDirectory: dataDirectory,
      dataDirectory,
      host: "127.0.0.1",
      port: 0,
      baseUrl: "http://golem.test",
      shareUrl: null,
      allowedEmails: ["anna@example.com", "otto@example.com"],
      google: {
        clientId: "test-client.apps.googleusercontent.com",
        clientSecret: "test-secret",
      },
      iosAppId: null,
      apns: null,
    },
    { provider: faux.provider, name: "Test model", defaultModel: model.id },
    Secrets.forTests(),
    embedder
  );
  ({ handler, dispose } = HttpRouter.toWebHandler(routes(app, allRoutes), {
    disableLogger: true,
  }));
});

afterAll(async () => {
  await dispose();
  await closeApp(app);
  await rm(dataDirectory, { recursive: true, force: true });
});

async function person(
  name: string,
  email: string
): Promise<{ user: User; token: string }> {
  const { internalAdapter } = await app.auth.$context;
  const created = await internalAdapter.createUser(
    { name, email, emailVerified: true },
    { method: "oauth", oauth: { providerId: "google" } }
  );
  return {
    user: { id: created.id, name, email },
    token: (await internalAdapter.createSession(created.id)).token,
  };
}

async function note(
  workspaceId: string,
  path: string,
  text: string
): Promise<void> {
  const file = join(dataDirectory, "workspaces", workspaceId, "notes", path);
  await mkdir(join(file, ".."), { recursive: true });
  await Bun.write(file, text);
}

test("text is chunked with overlap, and only prose is embedded", () => {
  const parts = chunk("word ".repeat(1000), 1800, 200);
  expect(parts.length).toBe(3);
  expect(parts.every((part) => part.length <= 1800)).toBe(true);
  expect(isProse("The dentist moved Tuesday's appointment")).toBe(true);
  expect(isProse("INV-2026-0042 4711")).toBe(false);
});

test("an index finds by meaning and by words, and re-embeds when the model changes", async () => {
  const path = join(dataDirectory, "unit.sqlite");
  const index = new WorkspaceIndex(path, "model-a");
  const source = { kind: "note" as const, version: "1", updatedAt: 0 };
  await index.sync(
    { ...source, uri: "notes/dentist.md", title: "Dentist" },
    async () => ({
      segments: [
        {
          key: "0",
          text: "The dentist appointment moved to Tuesday afternoon",
        },
      ],
    })
  );
  await index.sync(
    { ...source, uri: "notes/car.md", title: "Car" },
    async () => ({
      segments: [
        {
          key: "0",
          text: "Renew the car insurance before the end of the month",
        },
      ],
    })
  );
  index.storeVectors(
    index
      .waiting(10)
      .map((segment) => ({ id: segment.id, vector: bagOfWords(segment.text) }))
  );
  expect(
    index
      .search("dentist tuesday", bagOfWords("dentist tuesday"), 5, all)
      .map((result) => result.title)
  ).toEqual(["Dentist"]);
  expect(
    index.search("insurance", null, 5, all).map((result) => result.title)
  ).toEqual(["Car"]);
  index.close();
  const reopened = new WorkspaceIndex(path, "model-b");
  expect(reopened.counts().waiting).toBe(2);
  reopened.close();
});

test("search covers one workspace and never another, also through the agent's recall tool", async () => {
  const anna = await person("Anna", "anna@example.com");
  const otto = await person("Otto", "otto@example.com");
  const family = await app.workspaces.create(anna.user, "Family");
  const work = await app.workspaces.create(otto.user, "Work");
  await note(
    family.id,
    "health/dentist.md",
    "# Dentist\n\nThe dentist appointment moved to Tuesday afternoon."
  );
  await note(
    work.id,
    "secret.md",
    "# Payroll\n\nThe dentist plan for staff is confidential."
  );

  // The agent recalls before answering; the faux model records what the recall tool returned.
  let recalled = "";
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("recall", { query: "dentist appointment" })],
      { stopReason: "toolUse" }
    ),
    (context) => {
      recalled = JSON.stringify(context.messages.at(-1));
      return fauxAssistantMessage("It moved to Tuesday afternoon.");
    },
  ]);
  await app.indexer.scan(family.id);
  await app.indexer.scan(work.id);
  const channel = app.workspaces.channels(family.id, anna.user)[0]!;
  await app.threads.create(
    family.id,
    anna.user,
    channel.id,
    "When is the dentist?"
  );
  for (let attempt = 0; attempt < 100 && !recalled; attempt += 1) {
    await Bun.sleep(20);
  }
  expect(recalled).toContain("Dentist");
  expect(recalled).not.toContain("Payroll");

  await app.indexer.scan(family.id);
  const found = await app.indexer.search(family.id, "dentist", 20, null);
  expect(found.semantic).toBe(true);
  expect(found.results.map((result) => result.kind).sort()).toEqual([
    "note",
    "thread",
  ]);
  expect(found.results.some((result) => result.title === "Payroll")).toBe(
    false
  );

  const response = await handler(
    new Request(
      `http://golem.test/api/v1/workspaces/${family.id}/search?q=dentist`,
      { headers: { authorization: `Bearer ${otto.token}` } }
    )
  );
  expect(response.status).toBe(404);
  const own = await handler(
    new Request(
      `http://golem.test/api/v1/workspaces/${work.id}/search?q=dentist`,
      { headers: { authorization: `Bearer ${otto.token}` } }
    )
  );
  expect(
    ((await own.json()) as { results: { title: string }[] }).results.map(
      (result) => result.title
    )
  ).toEqual(["Payroll"]);
});

function mediaWord(input: object): string {
  return "image" in input ? "picture" : "sound";
}

const prose = (topic: string) =>
  `The family wrote this note about the ${topic} for the whole week`;

async function sync(
  index: WorkspaceIndex,
  uri: string,
  version: string,
  segments: Segment[],
  title = "Note"
): Promise<boolean> {
  let read = false;
  await index.sync(
    { uri, kind: "note", title, version, updatedAt: 0 },
    async () => {
      read = true;
      return { segments };
    }
  );
  return read;
}

function embedWaiting(index: WorkspaceIndex): number[] {
  const waiting = index.waiting(100);
  index.storeVectors(
    waiting.map((segment) => ({
      id: segment.id,
      vector: bagOfWords(segment.text),
    }))
  );
  return waiting.map((segment) => segment.id);
}

test("a changed source keeps the vectors of unchanged segments and replaces the others", async () => {
  const index = new WorkspaceIndex(":memory:", "model");
  const segments = [
    { key: "a", text: prose("garden") },
    { key: "b", text: prose("kitchen") },
    { key: "c", text: prose("garage") },
  ];
  await sync(index, "notes/house.md", "1", segments, "Chores");
  const [garden] = embedWaiting(index);
  expect(await sync(index, "notes/house.md", "1", [])).toBe(false);

  expect(
    await sync(
      index,
      "notes/house.md",
      "2",
      [
        segments[0]!,
        { key: "b", text: prose("bathroom") },
        { key: "d", text: prose("attic") },
      ],
      "Cleaning"
    )
  ).toBe(true);
  expect(index.counts()).toEqual({ sources: 1, segments: 3, waiting: 2 });
  expect(
    index
      .waiting(10)
      .map((segment) => segment.text)
      .toSorted((first, second) => first.localeCompare(second))
  ).toEqual([prose("attic"), prose("bathroom")]);
  embedWaiting(index);
  const meaning = index.search("garden", bagOfWords(prose("garden")), 5, all);
  expect(meaning.map((result) => result.snippet)).toEqual([prose("garden")]);
  expect(meaning[0]?.title).toBe("Cleaning");
  expect(index.waiting(10).some((segment) => segment.id === garden)).toBe(
    false
  );
  // The new title reaches unchanged segments too; the old title and the removed segment are gone.
  expect(index.search("chores", null, 5, all)).toEqual([]);
  expect(index.search("garage", null, 5, all)).toEqual([]);
  expect(index.search("cleaning", null, 5, all).length).toBe(1);
  index.close();
});

test("a picture without a vector is read again until the model gives one, and again after the model changes", async () => {
  const path = join(dataDirectory, "media.sqlite");
  let index = new WorkspaceIndex(path, "model-a");
  const picture = {
    key: "image",
    modality: "image" as const,
    text: "Picture",
    hash: "v1:image",
  };
  expect(await sync(index, "files/beach.jpg", "1", [picture], "beach")).toBe(
    true
  );
  expect(index.search("picture", bagOfWords("picture"), 5, all)).toEqual([]);
  expect(await sync(index, "files/beach.jpg", "1", [picture], "beach")).toBe(
    true
  );
  await sync(
    index,
    "files/beach.jpg",
    "1",
    [{ ...picture, vector: bagOfWords("picture") }],
    "beach"
  );
  expect(await sync(index, "files/beach.jpg", "1", [picture], "beach")).toBe(
    false
  );

  const found = index.search("photo", bagOfWords("picture"), 5, all);
  expect(found.map((result) => [result.title, result.modality])).toEqual([
    ["beach", "image"],
  ]);
  // A picture's label is not a keyword; its title is.
  expect(index.search("picture", null, 5, all)).toEqual([]);
  expect(index.search("beach", null, 5, all).length).toBe(1);
  index.close();

  index = new WorkspaceIndex(path, "model-b");
  expect(index.search("photo", bagOfWords("picture"), 5, all).length).toBe(1);
  expect(await sync(index, "files/beach.jpg", "1", [picture], "beach")).toBe(
    true
  );
  index.close();
});

test("prune removes sources that are gone, with their keywords", async () => {
  const index = new WorkspaceIndex(":memory:", "model");
  await sync(index, "notes/keep.md", "1", [
    { key: "0", text: "violin lesson" },
  ]);
  await sync(index, "notes/gone.md", "1", [
    { key: "0", text: "violin repair" },
  ]);
  index.prune(new Set(["notes/keep.md", "notes/gone.md"]));
  expect(index.counts().sources).toBe(2);
  index.prune(new Set(["notes/keep.md"]));
  expect(index.counts()).toEqual({ sources: 1, segments: 1, waiting: 0 });
  expect(
    index.search("violin", null, 5, all).map((result) => result.uri)
  ).toEqual(["notes/keep.md"]);
  index.close();
});

test("search handles stop words, a text without vectors, and long excerpts", async () => {
  const index = new WorkspaceIndex(":memory:", "model");
  const long = `${"Morning routine and breakfast. ".repeat(10)}The passport is in the blue folder. ${"Evening routine and dinner. ".repeat(10)}`;
  await sync(index, "notes/long.md", "1", [{ key: "0", text: long }]);
  expect(index.search("the and of", null, 5, all)).toEqual([]);
  expect(index.search("passport", bagOfWords("passport"), 5, all).length).toBe(
    1
  );
  const [result] = index.search("passport", null, 5, all);
  expect(result?.snippet.startsWith("…")).toBe(true);
  expect(result?.snippet.endsWith("…")).toBe(true);
  expect(result?.snippet).toContain("The passport is in the blue folder.");
  expect(result?.snippet.length).toBeLessThanOrEqual(202);
  index.close();
});

test("a query of 500 words uses only its first 32 terms", async () => {
  const index = new WorkspaceIndex(":memory:", "model");
  await sync(index, "notes/passport.md", "1", [
    { key: "0", text: "The passport is in the blue folder." },
  ]);
  const words = Array.from({ length: 500 }, (_, number) => `word${number}`);
  expect(
    index.search(["passport", ...words].join(" "), null, 5, all)
  ).toHaveLength(1);
  expect(index.search([...words, "passport"].join(" "), null, 5, all)).toEqual(
    []
  );
  index.close();
});

test("with many vectors, meaning is measured against the index's own spread", async () => {
  const index = new WorkspaceIndex(":memory:", "model");
  const topics = Array.from(
    { length: 60 },
    (_, number) =>
      `topic${String.fromCharCode(97 + (number % 26), 97 + Math.floor(number / 26))}`
  );
  for (const topic of topics) {
    await sync(
      index,
      `notes/${topic}.md`,
      "1",
      [{ key: "0", text: prose(topic) }],
      topic
    );
  }
  embedWaiting(index);
  const results = index.search(
    "which note",
    bagOfWords(prose("topicqb")),
    5,
    all
  );
  expect(results[0]?.title).toBe("topicqb");
  expect(results[0]?.modality).toBe("text");
  index.close();
});

test("a picture that only stands out among widely spread pictures does not show", async () => {
  const index = new WorkspaceIndex(":memory:", "model");
  // A unit vector whose cosine with the query (the first axis) is `similarity`.
  const scored = (similarity: number) => {
    const vector = new Float32Array(768);
    vector[0] = similarity;
    vector[1] = Math.sqrt(1 - similarity ** 2);
    return vector;
  };
  const media = async (
    title: string,
    modality: "image" | "audio",
    similarity: number
  ) => {
    await index.sync(
      { uri: title, kind: "file", title, version: "1", updatedAt: 0 },
      async () => ({
        segments: [
          {
            key: "0",
            hash: title,
            modality,
            text: "",
            vector: scored(similarity),
          },
        ],
      })
    );
  };
  for (let number = 0; number < 60; number += 1) {
    await media(`sound${number}`, "audio", number % 2 ? 0.58 : 0.62);
  }
  for (let number = 0; number < 30; number += 1) {
    await media(`picture${number}`, "image", number % 2 ? 0.4 : 0.6);
  }
  await media("related sound", "audio", 0.7);
  await media("unrelated picture", "image", 0.75);
  expect(
    index.search("query", scored(1), 10, all).map((result) => result.title)
  ).toEqual(["related sound"]);
  index.close();
});

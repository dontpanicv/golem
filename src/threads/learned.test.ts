import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Learned, type ReviewInput } from "./learned.ts";

const ALICE = { id: "alice", name: "Alice" };
const BOB = { id: "bob", name: "Bob" };
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function open(): Promise<Learned> {
  const directory = await mkdtemp(join(tmpdir(), "golem-learned-"));
  directories.push(directory);
  return new Learned(join(directory, "memory.sqlite"));
}

function input(changes: Partial<ReviewInput> = {}): ReviewInput {
  return {
    threadId: "thread-1",
    threadTitle: "Lunch",
    channel: { id: "food", name: "food" },
    realm: null,
    people: [ALICE, BOB],
    automations: "",
    messages: [
      { messageId: 4, author: "Alice", text: "No meat for me", time: 1 },
    ],
    ...changes,
  };
}

/** A model that gives these answers in order, and keeps the prompts it got. */
function model(...answers: string[]) {
  const prompts: string[] = [];
  const summarize = (_system: string, text: string) => {
    prompts.push(text);
    return Promise.resolve(answers.shift() ?? "{}");
  };
  return { prompts, summarize };
}

const { signal } = new AbortController();

test("what a private thread teaches stays in its person's realm, and a shared thread sees only what everyone sees", async () => {
  const learned = await open();
  await learned.review(
    input(),
    model(
      JSON.stringify({ about: [{ person: "Alice", text: "Eats no meat" }] })
    ).summarize,
    signal
  );
  await learned.review(
    input({
      threadId: "orchestrator",
      channel: null,
      realm: "alice",
      people: [ALICE],
    }),
    model(
      JSON.stringify({
        about: [{ person: "Alice", text: "Plans a surprise for Bob" }],
        howto: ["Book the restaurant by phone"],
      })
    ).summarize,
    signal
  );
  expect(learned.forThread(null, "food").map((item) => item.text)).toEqual([
    "Eats no meat",
  ]);
  expect(learned.forThread("alice", null).map((item) => item.text)).toEqual([
    "Eats no meat",
    "Plans a surprise for Bob",
    "Book the restaurant by phone",
  ]);
  expect(learned.forPerson("bob").map((item) => item.text)).toEqual([
    "Eats no meat",
  ]);
  // Bob can change neither what he does not see nor what the review does not own.
  const surprise = learned
    .forPerson("alice")
    .find((item) => item.text === "Plans a surprise for Bob")!;
  expect(learned.change(surprise.id, "bob", "Nothing")).toBeNull();
  expect(learned.remove(surprise.id, "bob")).toBe(false);
  expect(learned.through("orchestrator")).toBe(4);
});

test("a review never writes for someone outside the thread, and sees what people removed", async () => {
  const learned = await open();
  await learned.review(
    input({ people: [ALICE] }),
    model(
      JSON.stringify({
        about: [
          { person: "Alice", text: "Eats no meat" },
          { person: "Bob", text: "Not in this thread" },
        ],
        suggest: [
          {
            kind: "routine",
            person: "Bob",
            name: "x",
            schedule: "0 7 * * *",
            instructions: "x",
          },
        ],
      })
    ).summarize,
    signal
  );
  const [fact] = learned.forPerson("alice");
  expect(learned.forPerson("alice")).toHaveLength(1);
  learned.remove(fact!.id, "alice");

  const second = model("{}");
  await learned.review(
    input({
      messages: [{ messageId: 9, author: "Alice", text: "Hi", time: 2 }],
    }),
    second.summarize,
    signal
  );
  expect(second.prompts[0]).toContain(
    "<removed>\n[1] About Alice: Eats no meat\n</removed>"
  );
});

test("a list that grows too long goes back to the model, which merges it", async () => {
  const learned = await open();
  const long = "word ".repeat(55).trim();
  const many = Array.from({ length: 6 }, () => ({
    person: "Alice",
    text: long,
  }));
  const reviewer = model(
    JSON.stringify({ about: many }),
    JSON.stringify({ about: [{ person: "Alice", text: "Short and merged" }] })
  );
  const suggestions = await learned.review(input(), reviewer.summarize, signal);
  expect(suggestions).toEqual([]);
  expect(reviewer.prompts[1]).toContain("too long");
  expect(learned.forPerson("alice").map((item) => item.text)).toEqual([
    "Short and merged",
  ]);
});

test("suggestions keep only the people of the thread and the fields their kind needs", async () => {
  const learned = await open();
  const suggestions = await learned.review(
    input(),
    model(
      JSON.stringify({
        suggest: [
          {
            kind: "reminder",
            person: "alice",
            text: "Call the dentist",
            at: "2030-01-02T09:00:00+01:00",
          },
          { kind: "routine", person: "Alice", name: "No schedule" },
          {
            kind: "reminder",
            person: "Eve",
            text: "x",
            at: "2030-01-02T09:00:00+01:00",
          },
        ],
      })
    ).summarize,
    signal
  );
  expect(suggestions).toEqual([
    {
      kind: "reminder",
      personId: "alice",
      text: "Call the dentist",
      at: "2030-01-02T09:00:00+01:00",
    },
  ]);
});

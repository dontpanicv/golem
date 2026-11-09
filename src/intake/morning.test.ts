import { expect, test } from "bun:test";
import {
  type MorningInput,
  type MorningMatter,
  validateMorningPlan,
} from "./morning.ts";

const input: MorningInput = {
  owner: "Alice",
  now: 0,
  updates: ["a", "b"].map((id) => ({
    id,
    chatId: null,
    proposedTitle: "Logs",
    proposedTopicId: "work",
    proposedNewTopic: null,
    message: "New logs",
    sourceIds: [],
  })),
  evidence: [],
  chats: [{ id: "chat", topicId: "work", title: "Logs", context: "" }],
  topics: [{ id: "work", name: "work", summary: null, private: false }],
  checks: [],
  corrections: [],
  knowledge: { facts: "", about: [], howto: [] },
  coverage: [],
};

const matter = (change: Partial<MorningMatter> = {}): MorningMatter => ({
  updates: ["a", "b"],
  chatId: "chat",
  title: "Logs",
  topicId: null,
  newTopic: null,
  message: "Both logs arrived [1][2].",
  ask: null,
  due: null,
  line: "Logs arrived",
  ...change,
});

const plan = (
  matters: MorningMatter[],
  dropped: { id: string; reason: string }[] = []
) => ({
  summary: "Morning",
  matters,
  dropped,
});

test("a morning plan places every update once, in a given chat or topic", () => {
  expect(validateMorningPlan(plan([matter()]), input).matters).toHaveLength(1);
  expect(
    validateMorningPlan(
      plan(
        [matter({ updates: ["a"], chatId: null, topicId: "work" })],
        [{ id: "b", reason: "Handled" }]
      ),
      input
    ).dropped
  ).toEqual([{ id: "b", reason: "Handled" }]);
  expect(() =>
    validateMorningPlan(plan([matter({ updates: ["a"] })]), input)
  ).toThrow("leaves updates out");
  expect(() =>
    validateMorningPlan(plan([matter(), matter({ updates: ["a"] })]), input)
  ).toThrow("places update a wrongly");
  expect(() =>
    validateMorningPlan(plan([matter({ updates: ["a", "b", "c"] })]), input)
  ).toThrow("places update c wrongly");
  expect(() =>
    validateMorningPlan(plan([matter({ chatId: "another" })]), input)
  ).toThrow("not given");
  expect(() =>
    validateMorningPlan(
      plan([matter({ chatId: null, topicId: "elsewhere" })]),
      input
    )
  ).toThrow("given or proposed topic");
  expect(() =>
    validateMorningPlan(plan([matter({ message: " " })]), input)
  ).toThrow("needs its message");
});

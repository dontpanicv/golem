import { expect, test } from "bun:test";
import {
  fallbackPlan,
  type MorningInput,
  type MorningMatter,
  planMorning,
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
  nudges: [],
  reminders: [],
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
  closed: [],
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

test("the summary names only matters with an ask or a deadline, and asks may be problems, not only requests", async () => {
  const lines = async (matters: MorningMatter[]) =>
    (
      await planMorning(async () => JSON.stringify(plan(matters)), input)
    ).matters.map((each) => each.line);
  expect(await lines([matter()])).toEqual([""]);
  expect(await lines([matter({ ask: "Look at why the logs fail" })])).toEqual([
    "Logs arrived",
  ]);
  expect(
    await lines([matter({ ask: "Look at why the logs fail", line: "" })])
  ).toEqual(["Look at why the logs fail"]);
  expect(await lines([matter({ due: "2026-11-11T09:00:00+01:00" })])).toEqual([
    "Logs arrived",
  ]);
  const prompts: string[] = [];
  await planMorning(async (system) => {
    prompts.push(system);
    return JSON.stringify(plan([matter()]));
  }, input);
  expect(prompts[0]).toContain("this does not work");
  expect(prompts[0]).toContain("When in doubt, set the ask");
});

test("without a model plan every matter keeps its summary line and no nudge closes", () => {
  const fallback = validateMorningPlan(fallbackPlan(input), input);
  expect(fallback.matters.map((each) => each.line)).toEqual(["Logs", "Logs"]);
  expect(fallback.closed).toEqual([]);
});

test("a morning plan closes only a nudge that is due, as resolved or stopped", () => {
  const due = {
    ...input,
    nudges: [{ id: "n", chatId: null, text: "Reply", sourceIds: [] }],
  };
  const closed = (id: string, state: string) =>
    ({
      ...plan([matter()]),
      closed: [{ id, state, reason: "Done" }],
    }) as never;
  expect(validateMorningPlan(closed("n", "stopped"), due).closed).toEqual([
    { id: "n", state: "stopped", reason: "Done" },
  ]);
  expect(() => validateMorningPlan(closed("other", "resolved"), due)).toThrow(
    "closes other wrongly"
  );
  expect(() => validateMorningPlan(closed("n", "open"), due)).toThrow(
    "closes n wrongly"
  );
});

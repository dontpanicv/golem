import { expect, test } from "bun:test";
import {
  type MorningInput,
  type MorningTopic,
  validateMorningPlan,
} from "./morning.ts";

const input: MorningInput = {
  owner: "Alice",
  now: 0,
  updates: ["a", "b"].map((id) => ({
    id,
    threadId: null,
    proposedTitle: "Logs",
    proposedChannelId: "work",
    proposedNewChannel: null,
    message: "New logs",
    sourceIds: [],
  })),
  evidence: [],
  threads: [{ id: "thread", channelId: "work", title: "Logs", context: "" }],
  channels: [{ id: "work", name: "work", summary: null, private: false }],
  checks: [],
  corrections: [],
  coverage: [],
};

const topic = (change: Partial<MorningTopic> = {}): MorningTopic => ({
  updates: ["a", "b"],
  threadId: "thread",
  title: "Logs",
  channelId: null,
  newChannel: null,
  message: "Both logs arrived [1][2].",
  ask: null,
  due: null,
  line: "Logs arrived",
  ...change,
});

const plan = (
  topics: MorningTopic[],
  dropped: { id: string; reason: string }[] = []
) => ({
  summary: "Morning",
  topics,
  dropped,
});

test("a morning plan places every update once, in a given thread or channel", () => {
  expect(validateMorningPlan(plan([topic()]), input).topics).toHaveLength(1);
  expect(
    validateMorningPlan(
      plan(
        [topic({ updates: ["a"], threadId: null, channelId: "work" })],
        [{ id: "b", reason: "Handled" }]
      ),
      input
    ).dropped
  ).toEqual([{ id: "b", reason: "Handled" }]);
  expect(() =>
    validateMorningPlan(plan([topic({ updates: ["a"] })]), input)
  ).toThrow("leaves updates out");
  expect(() =>
    validateMorningPlan(plan([topic(), topic({ updates: ["a"] })]), input)
  ).toThrow("places update a wrongly");
  expect(() =>
    validateMorningPlan(plan([topic({ updates: ["a", "b", "c"] })]), input)
  ).toThrow("places update c wrongly");
  expect(() =>
    validateMorningPlan(plan([topic({ threadId: "another" })]), input)
  ).toThrow("not given");
  expect(() =>
    validateMorningPlan(
      plan([topic({ threadId: null, channelId: "elsewhere" })]),
      input
    )
  ).toThrow("given or proposed channel");
  expect(() =>
    validateMorningPlan(plan([topic({ message: " " })]), input)
  ).toThrow("needs its message");
});

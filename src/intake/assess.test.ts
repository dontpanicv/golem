import { expect, test } from "bun:test";
import {
  type AssessmentInput,
  afterCalendarDays,
  assess,
  pragueTime,
} from "./assess.ts";

const evidence = {
  id: "source",
  conversation: "mail-thread",
  text: "Please reply within 30 days.",
  at: Date.parse("2026-10-01T10:00:00+02:00"),
  source: "Mail",
  url: null,
  fromOwner: true,
};
const input: AssessmentInput = {
  owner: "Alex",
  now: evidence.at,
  trigger: "evidence",
  newEvidenceIds: [evidence.id],
  evidence: [evidence],
  topics: [],
  chats: [],
  checks: [],
  coverage: [],
};
const decision = {
  chatId: null,
  startChat: false,
  topicId: null,
  newTopic: null,
  title: "Repair claim",
  summary: "Response pending",
  message: "",
  attention: "none",
  evidence: ["source"],
  checks: [
    {
      id: null,
      text: "Check the response",
      evidence: "source",
      quote: evidence.text,
      at: null,
      afterDays: 30,
    },
  ],
  resolved: [],
};

test("assessment rejects invented quotes, destinations, dates and source ids", async () => {
  for (const change of [
    { chatId: "another-persons-chat" },
    { attention: "now" },
    { topicId: "another-persons-topic", startChat: true },
    { startChat: true },
    { startChat: true, topicId: "calendar", title: "x".repeat(61) },
    { startChat: true, newTopic: { name: "", summary: "Events" } },
    { startChat: true, newTopic: { name: "events-", summary: "Events" } },
    {
      startChat: true,
      newTopic: { name: "work--events", summary: "Events" },
    },
    { startChat: true, newTopic: { name: "events", summary: "" } },
    { evidence: ["invented"] },
    { checks: [{ ...decision.checks[0], quote: "fabricated words" }] },
    { checks: [{ ...decision.checks[0], afterDays: -1 }] },
    {
      checks: [
        { ...decision.checks[0], at: "2026-11-01T12:00:00", afterDays: null },
      ],
    },
  ]) {
    await expect(
      assess(
        async () => JSON.stringify({ decisions: [{ ...decision, ...change }] }),
        input
      )
    ).rejects.toThrow();
  }
  const valid = await assess(
    async () => JSON.stringify({ decisions: [decision] }),
    input
  );
  expect(valid[0]!.checks[0]!.afterDays).toBe(30);
});

test("new subjects use a visible topic or propose a private topic with supporting evidence", async () => {
  const calendar = {
    id: "calendar",
    name: "kalendar",
    summary: "Events",
    private: false,
  };
  const destination = { ...input, topics: [calendar] };
  for (const route of [
    { topicId: calendar.id, newTopic: null },
    {
      topicId: null,
      newTopic: { name: "events", summary: "Events and tickets" },
    },
  ]) {
    const [valid] = await assess(
      async () =>
        JSON.stringify({
          decisions: [{ ...decision, ...route, startChat: true }],
        }),
      destination
    );
    expect(valid!.startChat).toBe(true);
    await expect(
      assess(
        async () =>
          JSON.stringify({
            decisions: [
              {
                ...decision,
                ...route,
                startChat: true,
                evidence: [],
                checks: [],
                summary: "",
              },
            ],
          }),
        destination
      )
    ).rejects.toThrow();
  }
  await expect(
    assess(
      async () =>
        JSON.stringify({
          decisions: [
            {
              ...decision,
              startChat: true,
              topicId: calendar.id,
              newTopic: { name: "events", summary: "Events" },
            },
          ],
        }),
      destination
    )
  ).rejects.toThrow();
});

test("a later context-only review cannot recreate an old resolved commitment", async () => {
  await expect(
    assess(async () => JSON.stringify({ decisions: [decision] }), {
      ...input,
      newEvidenceIds: [],
    })
  ).rejects.toThrow();
});

test("a useful chat review is silent when the judge omits notification permission", async () => {
  const [review] = await assess(
    async () =>
      JSON.stringify({
        decisions: [
          {
            ...decision,
            checks: [],
            chatId: "subject",
            attention: "now",
            message: "The draft is available",
          },
        ],
      }),
    {
      ...input,
      chats: [{ id: "subject", topicId: "topic", title: "Draft", context: "" }],
    }
  );
  expect(review!.notification).toBeNull();
  expect(review!.attention).toBe("now");
});

test("notification permission needs an allowed reason, exact evidence, and the owner's request when claimed", async () => {
  const context: AssessmentInput = {
    ...input,
    evidence: [{ ...evidence, text: "Tell me when the contract arrives." }],
    chats: [
      { id: "subject", topicId: "topic", title: "Contract", context: "" },
    ],
  };
  const notice = {
    kind: "requested" as const,
    reason: "The owner asked for this update",
    evidence: "source",
    quote: context.evidence[0]!.text,
  };
  const review = {
    ...decision,
    chatId: "subject",
    checks: [],
    attention: "now",
    message: "The contract arrived",
    notification: notice,
  };
  const complete = async (value: unknown = review) =>
    JSON.stringify({ decisions: [value] });
  expect((await assess(() => complete(), context))[0]!.notification!.kind).toBe(
    "requested"
  );
  for (const change of [
    { kind: "important" },
    { quote: "invented words" },
    { reason: "" },
    { evidence: "unknown" },
  ]) {
    await expect(
      assess(
        () => complete({ ...review, notification: { ...notice, ...change } }),
        context
      )
    ).rejects.toThrow();
  }
  await expect(
    assess(() => complete(), {
      ...context,
      evidence: [{ ...context.evidence[0]!, fromOwner: false }],
    })
  ).rejects.toThrow();
  await expect(
    assess(() => complete(), { ...context, pendingNotifications: [] })
  ).rejects.toThrow();
  await expect(
    assess(() => complete({ ...review, checks: decision.checks }), {
      ...context,
      trigger: "notification",
      newEvidenceIds: [],
      pendingNotifications: [notice],
    })
  ).rejects.toThrow();
});

test("a due notice requires an unresolved stated time, never an arbitrary internal review time", async () => {
  const deadline = afterCalendarDays(evidence.at, 30);
  const check = {
    id: "check",
    chatId: "subject",
    text: "Response pending",
    sourceIds: ["source"],
    checkAt: deadline,
    deadlineAt: deadline,
    reviewAt: deadline,
    notifiedAt: null,
  };
  const context: AssessmentInput = {
    ...input,
    now: deadline,
    trigger: "time",
    newEvidenceIds: [],
    checks: [check],
    chats: [{ id: "subject", topicId: "topic", title: "Claim", context: "" }],
  };
  const review = {
    ...decision,
    chatId: "subject",
    checks: [],
    attention: "now",
    message: "The stated response period passed",
    notification: {
      kind: "due",
      reason: "The stated time arrived",
      evidence: "source",
      quote: evidence.text,
    },
  };
  const complete = async () => JSON.stringify({ decisions: [review] });
  expect((await assess(complete, context))[0]!.notification!.kind).toBe("due");
  await expect(
    assess(complete, { ...context, now: deadline - 1 })
  ).rejects.toThrow();
  await expect(
    assess(complete, { ...context, checks: [{ ...check, deadlineAt: null }] })
  ).rejects.toThrow();
  await expect(
    assess(complete, {
      ...context,
      checks: [{ ...check, notifiedAt: deadline }],
    })
  ).rejects.toThrow();
});

test("calendar-day follow-ups preserve the local hour across a clock change", () => {
  expect(new Date(afterCalendarDays(evidence.at, 30)).toISOString()).toBe(
    "2026-10-31T09:00:00.000Z"
  );
});

test("source-read reassessment can change existing checks but cannot create work or use an observation time as a deadline", async () => {
  const chat = {
    id: "claim",
    topicId: "home",
    title: "Claim",
    context: "",
  };
  const check = {
    id: "pending",
    chatId: chat.id,
    text: "Check the answer",
    sourceIds: [evidence.id],
    checkAt: input.now,
    deadlineAt: input.now,
    reviewAt: input.now,
    notifiedAt: null,
  };
  const review: AssessmentInput = {
    ...input,
    trigger: "source_read",
    newEvidenceIds: [],
    chats: [chat],
    checks: [check],
  };
  const revision = {
    ...decision,
    chatId: chat.id,
    notification: null,
    checks: [{ ...decision.checks[0]!, id: check.id, afterDays: null }],
  };
  expect(
    (
      await assess(
        async () => JSON.stringify({ decisions: [revision] }),
        review
      )
    )[0]!.checks[0]!.id
  ).toBe(check.id);
  for (const change of [
    { chatId: null },
    { attention: "now" },
    { checks: decision.checks },
    {
      resolved: [
        {
          id: check.id,
          evidence: evidence.id,
          quote: "The agent says it is done",
        },
      ],
    },
    {
      startChat: true,
      chatId: null,
      newTopic: { name: "claims", summary: "Claims" },
    },
  ]) {
    await expect(
      assess(
        async () => JSON.stringify({ decisions: [{ ...revision, ...change }] }),
        review
      )
    ).rejects.toThrow();
  }
  await expect(
    assess(
      async () =>
        JSON.stringify({
          decisions: [
            {
              ...revision,
              checks: [{ ...revision.checks[0]!, afterDays: 30 }],
            },
          ],
        }),
      { ...review, evidence: [{ ...evidence, observedAt: evidence.at }] }
    )
  ).rejects.toThrow("A future check has no valid evidence or time");
});

test("a final destination assessment cannot split a proposal, invent checks, or promote a silent update", async () => {
  const finalInput: AssessmentInput = {
    ...input,
    trigger: "destination",
    newEvidenceIds: [],
    pendingNotice: "Review this claim",
    pendingNotifications: [],
    pendingSubject: {
      title: "Claim",
      summary: "Repair claim",
      topicId: null,
      newTopic: { name: "repairs", summary: "Repairs" },
    },
  };
  const finalDecision = {
    ...decision,
    startChat: true,
    newTopic: { name: "repairs", summary: "Repairs" },
    checks: [],
    attention: "now",
    message: "Review the repair claim",
    notification: null,
  };
  expect(
    await assess(
      async () => JSON.stringify({ decisions: [finalDecision] }),
      finalInput
    )
  ).toHaveLength(1);
  for (const decisions of [
    [finalDecision, finalDecision],
    [{ ...finalDecision, checks: decision.checks }],
    [
      {
        ...finalDecision,
        notification: {
          kind: "requested",
          reason: "Tell the owner",
          evidence: evidence.id,
          quote: evidence.text,
        },
      },
    ],
  ]) {
    await expect(
      assess(async () => JSON.stringify({ decisions }), finalInput)
    ).rejects.toThrow();
  }
});

test("the model reads times as the family's Prague wall clock, with the offset, across daylight-saving changes", () => {
  for (const [utc, local] of [
    ["2026-11-07T08:00:00Z", "2026-11-07T09:00:00+01:00"],
    ["2026-07-01T22:30:15Z", "2026-07-02T00:30:15+02:00"],
    ["2026-03-29T00:59:59Z", "2026-03-29T01:59:59+01:00"],
    ["2026-03-29T01:00:00Z", "2026-03-29T03:00:00+02:00"],
  ]) {
    expect(pragueTime(Date.parse(utc!))).toBe(local!);
    expect(Date.parse(local!)).toBe(Date.parse(utc!));
  }
});

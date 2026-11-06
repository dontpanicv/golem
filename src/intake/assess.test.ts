import { expect, test } from "bun:test";
import { type AssessmentInput, afterCalendarDays, assess } from "./assess.ts";

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
  channels: [],
  threads: [],
  checks: [],
  coverage: [],
};
const decision = {
  threadId: null,
  startThread: false,
  channelId: null,
  newChannel: null,
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
    { threadId: "another-persons-thread" },
    { attention: "now" },
    { channelId: "another-persons-channel", startThread: true },
    { startThread: true },
    { startThread: true, channelId: "calendar", title: "x".repeat(61) },
    { startThread: true, newChannel: { name: "", summary: "Events" } },
    { startThread: true, newChannel: { name: "events-", summary: "Events" } },
    {
      startThread: true,
      newChannel: { name: "work--events", summary: "Events" },
    },
    { startThread: true, newChannel: { name: "events", summary: "" } },
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

test("new subjects use a visible channel or propose a private channel with supporting evidence", async () => {
  const calendar = {
    id: "calendar",
    name: "kalendar",
    summary: "Events",
    private: false,
  };
  const destination = { ...input, channels: [calendar] };
  for (const route of [
    { channelId: calendar.id, newChannel: null },
    {
      channelId: null,
      newChannel: { name: "events", summary: "Events and tickets" },
    },
  ]) {
    const [valid] = await assess(
      async () =>
        JSON.stringify({
          decisions: [{ ...decision, ...route, startThread: true }],
        }),
      destination
    );
    expect(valid!.startThread).toBe(true);
    await expect(
      assess(
        async () =>
          JSON.stringify({
            decisions: [
              {
                ...decision,
                ...route,
                startThread: true,
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
              startThread: true,
              channelId: calendar.id,
              newChannel: { name: "events", summary: "Events" },
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

test("a useful thread review is silent when the judge omits notification permission", async () => {
  const [review] = await assess(
    async () =>
      JSON.stringify({
        decisions: [
          {
            ...decision,
            checks: [],
            threadId: "subject",
            attention: "now",
            message: "The draft is available",
          },
        ],
      }),
    {
      ...input,
      threads: [
        { id: "subject", channelId: "channel", title: "Draft", context: "" },
      ],
    }
  );
  expect(review!.notification).toBeNull();
  expect(review!.attention).toBe("now");
});

test("notification permission needs an allowed reason, exact evidence, and the owner's request when claimed", async () => {
  const context: AssessmentInput = {
    ...input,
    evidence: [{ ...evidence, text: "Tell me when the contract arrives." }],
    threads: [
      { id: "subject", channelId: "channel", title: "Contract", context: "" },
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
    threadId: "subject",
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
    threadId: "subject",
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
    threads: [
      { id: "subject", channelId: "channel", title: "Claim", context: "" },
    ],
  };
  const review = {
    ...decision,
    threadId: "subject",
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
  const thread = {
    id: "claim",
    channelId: "home",
    title: "Claim",
    context: "",
  };
  const check = {
    id: "pending",
    threadId: thread.id,
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
    threads: [thread],
    checks: [check],
  };
  const revision = {
    ...decision,
    threadId: thread.id,
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
    { threadId: null },
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
      startThread: true,
      threadId: null,
      newChannel: { name: "claims", summary: "Claims" },
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
      channelId: null,
      newChannel: { name: "repairs", summary: "Repairs" },
    },
  };
  const finalDecision = {
    ...decision,
    startThread: true,
    newChannel: { name: "repairs", summary: "Repairs" },
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

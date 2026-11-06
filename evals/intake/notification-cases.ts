import type { AssessmentInput, Evidence } from "../../src/intake/assess.ts";

const now = Date.parse("2026-11-04T10:00:00+01:00");
const day = 86_400_000;
const request: Evidence = {
  id: "request",
  conversation: "slack:project",
  text: "Can you review the draft?",
  at: now - 3_600_000,
  source: "Slack; project discussion; colleague",
  url: null,
  fromOwner: false,
};
const base: AssessmentInput = {
  owner: "Alex",
  now,
  trigger: "evidence",
  newEvidenceIds: ["request"],
  evidence: [request],
  channels: [
    { id: "work", name: "work", summary: "Work discussions", private: true },
    {
      id: "calendar",
      name: "kalendar",
      summary: "Events and tickets",
      private: false,
    },
  ],
  threads: [
    {
      id: "discussion",
      channelId: "work",
      title: "Draft review",
      context:
        "Alex and a colleague are discussing a draft. No deadline has been agreed.",
    },
  ],
  checks: [],
  coverage: [{ source: "Slack", through: now, error: null }],
};
const period: Evidence = {
  ...request,
  id: "period",
  fromOwner: true,
  source: "Gmail; repair claim; Alex",
  text: "Please provide a substantive response within 30 calendar days.",
  at: now - 30 * day,
};
const due: AssessmentInput = {
  ...base,
  trigger: "time",
  newEvidenceIds: [],
  evidence: [period],
  threads: [
    {
      id: "discussion",
      channelId: "work",
      title: "Repair claim",
      context:
        "Alex is waiting for a substantive repair plan. No response has arrived.",
    },
  ],
  checks: [
    {
      id: "period-check",
      threadId: "discussion",
      text: "Substantive response to repair claim",
      sourceIds: [period.id],
      checkAt: now,
      deadlineAt: now,
      reviewAt: now,
      notifiedAt: null,
    },
  ],
  coverage: [{ source: "Gmail", through: now, error: null }],
};

/** Invented notification examples. Private replay data must stay outside this repository. */
export const notificationCases: {
  id: string;
  expectedNotification: boolean;
  expectedUndatedCheck?: boolean;
  input: AssessmentInput;
}[] = [
  {
    id: "ordinary-message-unanswered-hour",
    expectedNotification: false,
    input: base,
  },
  {
    id: "ordinary-message-owner-replied",
    expectedNotification: false,
    input: {
      ...base,
      evidence: [
        request,
        {
          ...request,
          id: "handled",
          text: "I reviewed it and sent my comments.",
          fromOwner: true,
          at: now,
        },
      ],
      newEvidenceIds: ["handled"],
    },
  },
  {
    id: "mention-is-not-an-interruption-reason",
    expectedNotification: false,
    input: {
      ...base,
      evidence: [
        { ...request, text: "@me can you check the draft when you have time?" },
      ],
    },
  },
  { id: "explicit-period-now-due", expectedNotification: true, input: due },
  {
    id: "explicit-period-not-yet-due",
    expectedNotification: false,
    input: { ...due, now: now - 3_600_000 },
  },
  {
    id: "awaited-repair-plan",
    expectedNotification: true,
    input: {
      ...due,
      trigger: "evidence",
      newEvidenceIds: ["plan"],
      evidence: [
        period,
        {
          ...request,
          id: "plan",
          text: "Here is our substantive repair plan. The crew can start next Monday; please confirm access.",
          source: "Gmail; repair claim; builder",
          at: now,
        },
      ],
    },
  },
  {
    id: "conference-ticket-today",
    expectedNotification: true,
    input: {
      ...base,
      threads: [],
      evidence: [
        {
          ...request,
          text: "Your conference is today, 4 November 2026, at 12:00 in building Q. Registration opens at 11:30. Your ticket and programme are attached.",
          source: "Gmail; conference ticket; organiser",
          at: now - day,
        },
      ],
      coverage: [{ source: "Gmail", through: now, error: null }],
    },
  },
  {
    id: "requested-approval-update",
    expectedNotification: true,
    input: {
      ...base,
      threads: [
        {
          id: "discussion",
          channelId: "work",
          title: "Permit application",
          context:
            "Alex is waiting for the permit decision and asked Golem to report it.",
        },
      ],
      evidence: [
        {
          ...request,
          id: "instruction",
          text: "Tell me when the permit decision arrives.",
          fromOwner: true,
          at: now - day,
        },
        {
          ...request,
          id: "permit",
          text: "Your permit has been approved.",
          at: now,
        },
      ],
      newEvidenceIds: ["permit"],
    },
  },
  {
    id: "unresolved-claim-without-deadline",
    expectedNotification: false,
    expectedUndatedCheck: true,
    input: {
      ...base,
      evidence: [
        {
          ...request,
          fromOwner: true,
          text: "Only some window handles have been replaced; we are waiting for the rest to be made. The other defects still have no written answer. Please send our request for a written response.",
        },
      ],
      threads: [
        {
          id: "discussion",
          channelId: "work",
          title: "Repair claim",
          context:
            "Latest messages first: Golem: I sent the approved follow-up email. The remaining defects have no written answer. The first notice and delivery dates are not established.",
        },
      ],
    },
  },
  ...[false, true].map(
    (
      handled
    ): {
      id: string;
      expectedNotification: boolean;
      input: AssessmentInput;
    } => {
      const ticket: Evidence = {
        ...request,
        conversation: "gmail:conference",
        source: "Gmail; conference ticket; organiser",
        at: now - 3_600_000,
        text: "Your conference is today, 4 November 2026, at 12:00 in building Q. Registration opens at 11:30. Your ticket and programme are attached.",
      };
      return {
        id: handled
          ? "final-notification-owner-already-handling"
          : "final-notification-confirmed-conference",
        expectedNotification: !handled,
        input: {
          ...base,
          trigger: "notification",
          newEvidenceIds: [],
          evidence: [
            ticket,
            ...(handled
              ? [
                  {
                    ...ticket,
                    id: "handled",
                    fromOwner: true,
                    at: now - 60_000,
                    text: "I already have the ticket and programme. I am on my way.",
                  },
                ]
              : []),
          ],
          threads: [
            {
              id: "discussion",
              channelId: "calendar",
              title: "Conference today",
              context:
                "Golem prepared the ticket, programme, and arrival details silently.",
            },
          ],
          coverage: [{ source: "Gmail", through: now, error: null }],
          pendingNotice:
            "Your conference is confirmed for 12:00 today in building Q. Registration opens at 11:30. The ticket and programme are ready in this thread.",
          pendingNotifications: [
            {
              kind: "time_sensitive",
              reason:
                "Arrival details and the ticket are useful before today's conference.",
              evidence: "request",
              quote:
                "Your conference is today, 4 November 2026, at 12:00 in building Q.",
            },
          ],
        },
      };
    }
  ),
];

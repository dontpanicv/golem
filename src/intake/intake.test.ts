import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { HttpRouter } from "effect/http";
import { startTestApp, type TestApp, until } from "../../test/harness.ts";
import { routes } from "../app/http.ts";
import type { WatchedItem } from "../integrations/integrations.ts";
import type { ThreadMessages } from "../threads/threads.ts";
import { intakeApiRoutes } from "./api.ts";
import {
  type Assessment,
  type AssessmentInput,
  afterCalendarDays,
} from "./assess.ts";
import { Audit } from "./audit.ts";
import { saveCheck } from "./future.ts";
import {
  Intake,
  type IntakeIntegrations,
  type IntakeThreads,
} from "./intake.ts";
import {
  MORNING_SYSTEM,
  type MorningInput,
  type MorningPlan,
} from "./morning.ts";
import { IntakeRecall } from "./recall.ts";

const DAY = 86_400_000;
const START = Date.parse("2026-10-01T10:00:00+02:00");
let app: TestApp;
let intake: Intake;
/** Runs right after an update is posted to a subject thread, as when the owner answers or a source fails then. */
let postHook: (() => void) | undefined;
afterEach(async () => {
  postHook = undefined;
  await intake?.close();
  intake?.audit.close();
  await app?.close();
});

async function setup(
  options: {
    correction?: (text: string) => string;
    initialNotice?: "brief" | "now";
    quietTime?: boolean;
    dialogue?: ThreadMessages["messages"];
    version?: string;
    target?: "private" | "shared";
    noticeReply?: boolean;
    actualReview?: boolean;
    decide?: (input: AssessmentInput) => Assessment[];
    source?: "google" | "slack" | "whatsapp";
    silent?: boolean;
    failAfterThreadStart?: boolean;
    plan?: (input: MorningInput) => MorningPlan;
    /** Fails a post to a thread, as when the conversation is not reachable. */
    postFails?: (threadId: string) => boolean;
  } = {}
) {
  app = await startTestApp();
  const token = await app.signIn("Alice", "alice@example.com");
  const { user } = (await (await app.call("/api/v1/me", { token })).json()) as {
    user: { id: string; name: string; email: string };
  };
  const home =
    app.app.workspaces.list(user)[0] ??
    (await app.app.workspaces.create(user, "Home"));
  const owner = { id: user.id, name: "Alice", email: "alice@example.com" };
  const workspaceId = home.id;
  const targetChannel = options.target
    ? app.app.workspaces.createChannel(
        workspaceId,
        owner,
        "flat-claims",
        options.target === "private"
      )
    : null;
  const target = targetChannel
    ? await app.app.threads.startAgentThread(
        workspaceId,
        targetChannel.id,
        "Flat repair claim"
      )
    : null;
  const posts: {
    threadId: string;
    text: string;
    notify: boolean;
    files: readonly { id: string; name: string }[];
  }[] = [];
  const plans: MorningInput[] = [];
  const reviews: {
    threadId: string;
    requestId: string;
    text: string;
    files: readonly { id: string; name: string }[];
  }[] = [];
  const credential = {
    id: "mail",
    workspaceId,
    ownerId: owner.id,
    integration: options.source ?? "google",
    integrationName: "Mail",
    label: "alice@example.com",
  };
  let items: WatchedItem[] = [
    item(
      "request",
      "Please give a substantive response to the balcony claim within 30 days.",
      true,
      START
    ),
  ];
  let outage = false;
  let enabled = true;
  let assessments = 0;
  const deliveries: string[] = [];
  const snapshots: AssessmentInput[] = [];
  const integrations: IntakeIntegrations = {
    watched: () => (enabled ? [credential] : []),
    watch: async () => {
      if (outage) {
        throw new Error("Account disconnected");
      }
      return items;
    },
    attachment: async () =>
      new TextEncoder().encode("BEGIN:VCALENDAR\nEND:VCALENDAR"),
  };
  let interruptCreation = options.failAfterThreadStart ?? false;
  const threads: IntakeThreads = {
    ...app.app.threads,
    messages: async () => ({
      messages: options.dialogue ?? [],
      running: false,
      approvals: [],
    }),
    observe: async (thread, text, requestId, observer, notify, files = []) => {
      if (options.postFails?.(thread.id)) {
        throw new Error("The thread is not reachable");
      }
      posts.push({ threadId: thread.id, text, notify, files });
      // A post to a subject thread, not to the person's own Golem thread.
      if (thread.ownerId === null) {
        reviews.push({ threadId: thread.id, requestId, text, files });
        if (!deliveries.some((each) => each.startsWith(requestId))) {
          deliveries.push(`${requestId} ${text}`);
        }
      }
      if (options.actualReview) {
        await app.app.threads.observe(
          thread,
          text,
          requestId,
          observer,
          notify,
          files
        );
      }
      if (thread.ownerId === null) {
        postHook?.();
      }
    },
    file: app.app.threads.file.bind(app.app.threads),
    orchestrator: app.app.threads.orchestrator.bind(app.app.threads),
    writeFile: app.app.threads.writeFile.bind(app.app.threads),
    deleteFile: app.app.threads.deleteFile.bind(app.app.threads),
    realm: async () => owner.id,
    requester: async () => owner,
    files: app.app.threads.files.bind(app.app.threads),
    place: app.app.threads.place.bind(app.app.threads),
    startAgentThread: async (...args) => {
      const thread = await app.app.threads.startAgentThread(...args);
      if (interruptCreation) {
        interruptCreation = false;
        throw new Error("Interrupted after thread creation");
      }
      return thread;
    },
  };
  const create = () =>
    new Intake(
      app.app.database,
      app.app.workspaces,
      integrations,
      threads,
      {
        search: async () => ({
          results: target
            ? [
                {
                  threadId: target.id,
                  channelId: target.channelId,
                  title: target.title,
                  uri: `thread:${target.id}`,
                  kind: "thread",
                  modality: "text",
                  loc: null,
                  score: 1,
                  snippet: "",
                  updatedAt: START,
                },
              ]
            : [],
          semantic: false,
        }),
      },
      {
        complete: async (_system, text) => {
          if (_system === MORNING_SYSTEM) {
            const input = JSON.parse(text) as MorningInput;
            plans.push(input);
            return JSON.stringify((options.plan ?? morningPlan)(input));
          }
          if (_system.startsWith("Apply the person's correction")) {
            if (!options.correction) {
              throw new Error("Unexpected correction call");
            }
            return options.correction(text);
          }
          assessments += 1;
          const input = JSON.parse(text) as AssessmentInput;
          snapshots.push(input);
          if (options.decide) {
            return JSON.stringify({ decisions: options.decide(input) });
          }
          if (input.trigger === "time" && options.quietTime) {
            return JSON.stringify({ decisions: [] });
          }
          const answer: Assessment = {
            threadId:
              target?.id ??
              input.threads.find((thread) => thread.title === "Balcony claim")
                ?.id ??
              null,
            startThread: false,
            channelId: null,
            newChannel: null,
            title: "Balcony claim",
            summary: "A response is pending",
            attention: "none",
            notification: null,
            message: "",
            evidence: [input.evidence[0]!.id],
            checks: [],
            resolved: [],
          };
          if (input.trigger === "notification") {
            answer.notification = input.pendingNotifications?.[0] ?? null;
            answer.evidence = answer.notification
              ? [answer.notification.evidence]
              : answer.evidence;
            answer.attention = "now";
            answer.message = input.pendingNotice!;
            return JSON.stringify({ decisions: [answer] });
          }
          const reply = input.evidence.find(
            (each) =>
              each.text ===
              "Here is the substantive response. Repairs start Monday."
          );
          if (reply) {
            answer.evidence = [reply.id];
            if (options.noticeReply) {
              answer.attention = "now";
              answer.message =
                "The developer replied. Review the repair plan and propose next actions.";
              answer.notification = {
                kind: "awaited_reply",
                reason: "The awaited repair plan needs review",
                evidence: reply.id,
                quote: reply.text,
              };
            }
            answer.resolved = input.checks.map((check) => ({
              id: check.id,
              evidence: reply.id,
              quote: reply.text,
            }));
          } else if (input.trigger === "time") {
            if (!input.checks[0]!.notifiedAt) {
              answer.attention = "now";
              answer.message = input.coverage.some((source) => source.error)
                ? "I could not verify a reply because the account is disconnected."
                : "The stated response period passed without a substantive reply.";
              answer.notification = {
                kind: "due",
                reason: "The stated response period has passed",
                evidence: answer.evidence[0]!,
                quote: input.evidence[0]!.text,
              };
            }
          } else if (!input.checks.length && input.trigger !== "destination") {
            if (options.initialNotice) {
              answer.attention = options.initialNotice;
              answer.message = "The repair claim is now being followed.";
            }
            const request = input.evidence.find((each) => each.fromOwner)!;
            answer.checks = [
              {
                id: null,
                text: "Substantive response to balcony claim",
                evidence: request.id,
                quote: request.text,
                at: null,
                afterDays: 30,
              },
            ];
          }
          if (input.trigger === "destination" && !reply) {
            answer.attention = input.checks.some(
              (check) => check.checkAt <= input.now
            )
              ? "now"
              : (options.initialNotice ?? "now");
            answer.message = input.pendingNotice!;
            answer.notification = input.pendingNotifications?.[0] ?? null;
          } else if (input.pendingNotice && input.trigger !== "destination") {
            answer.attention = "brief";
            answer.message = "The claim correspondence is available.";
          }
          if (options.silent) {
            answer.notification = null;
          }
          if (answer.attention !== "none" && answer.threadId === null) {
            answer.startThread = true;
            Object.assign(answer, newThreadPlace(input));
          }
          return JSON.stringify({ decisions: [answer] });
        },
      },
      new Audit(join(app.dataDirectory, "test-audit.sqlite")),
      app.app.notifications
    );
  intake = create();
  return {
    restart: async () => {
      await intake.close();
      intake.audit.close();
      intake = create();
    },
    owner,
    target,
    reviews,
    posts,
    plans,
    token,
    credential,
    enable: (value: boolean) => {
      enabled = value;
    },
    workspaceId,
    deliveries,
    snapshots,
    assessments: () => assessments,
    items: (next: WatchedItem[]) => {
      items = next;
    },
    outage: () => {
      outage = true;
    },
    recover: () => {
      outage = false;
    },
  };
}

/** Where the scripted judge starts a new thread: a given private channel, or a new private one when there is none. */
function newThreadPlace(input: { channels: { id: string }[] }) {
  const [channel] = input.channels;
  return channel
    ? { channelId: channel.id, newChannel: null }
    : { channelId: null, newChannel: { name: "sources", summary: "Sources" } };
}

/**
 * A judge for the tests of what a thread's agent read: the new reply's normal assessment does nothing, and the read's
 * own check resolves every check from the reply.
 */
function resolvesOnlyRead(input: AssessmentInput): Assessment[] {
  if (input.trigger !== "source_read") {
    return [];
  }
  const reply = input.evidence.find((each) =>
    each.text.startsWith("Here is the substantive response")
  )!;
  return [
    {
      threadId: input.threads[0]!.id,
      startThread: false,
      channelId: null,
      newChannel: null,
      title: input.threads[0]!.title,
      summary: "",
      attention: "none",
      notification: null,
      message: "",
      evidence: [reply.id],
      checks: [],
      resolved: input.checks.map((check) => ({
        id: check.id,
        evidence: reply.id,
        quote: reply.text,
      })),
    },
  ];
}

/** The person's subject threads, without their own Golem thread that the morning summary starts. */
function subjectThreads(run: { workspaceId: string; owner: { id: string } }) {
  return app.app.workspaces
    .threadsIn(run.workspaceId, run.owner.id)
    .filter((thread) => thread.ownerId === null);
}

/**
 * The morning plan of the scripted model: it drops every update once the owner handled the matter or the awaited
 * reply arrived, and else puts the updates of one thread or one proposed title into one topic.
 */
function morningPlan(input: MorningInput): MorningPlan {
  const handled = input.evidence.some(
    (each) =>
      each.text === "I handled this." ||
      each.text.startsWith("Here is the substantive response")
  );
  if (handled) {
    return {
      summary: "Nothing new",
      topics: [],
      dropped: input.updates.map((update) => ({
        id: update.id,
        reason: "Handled",
      })),
    };
  }
  const place = newThreadPlace(input);
  return {
    summary: "Good morning",
    topics: [
      ...Map.groupBy(
        input.updates,
        (update) => update.threadId ?? update.proposedTitle
      ).values(),
    ].map((updates) => ({
      updates: updates.map((update) => update.id),
      threadId: updates[0]!.threadId,
      title: updates[0]!.proposedTitle ?? "",
      channelId:
        updates[0]!.threadId || updates[0]!.proposedNewChannel
          ? null
          : (updates[0]!.proposedChannelId ?? place.channelId),
      newChannel: updates[0]!.threadId
        ? null
        : (updates[0]!.proposedNewChannel ??
          (updates[0]!.proposedChannelId ? null : place.newChannel)),
      message: updates.map((update) => update.message).join(" "),
      ask: null,
      due: null,
      line: updates[0]!.proposedTitle ?? "An update",
    })),
    dropped: [],
  };
}

function item(
  id: string,
  text: string,
  fromOwner: boolean,
  at: number,
  attachments: WatchedItem["attachments"] = []
) {
  return {
    id,
    text,
    fromOwner,
    at,
    kind: "message" as const,
    attachments,
    chat: `conversation-${id}`,
    chatName: "Balcony",
    sender: fromOwner ? "Alice" : "Builder",
    group: false,
    url: `https://mail.example.com/${id}`,
  };
}

function threadUpdate(input: AssessmentInput): Assessment {
  return {
    threadId: input.threads[0]!.id,
    startThread: false,
    channelId: null,
    newChannel: null,
    title: input.threads[0]!.title,
    summary: "The source discussion is available",
    attention: "now",
    notification: null,
    message: "Keep the useful context in this discussion",
    evidence: input.evidence.map((source) => source.id),
    checks: [],
    resolved: [],
  };
}

test("a queued source read survives restart and a partial answer revises only the unresolved question", async () => {
  const options: Parameters<typeof setup>[0] = { target: "private" };
  const run = await setup(options);
  await intake.tick(START);
  const original = intake.openChecks(run.workspaceId, run.owner)[0]!;
  const partial = item(
    "partial",
    "The link is sent. The apartment and booking still need confirmation.",
    true,
    START - DAY
  );
  intake.recordSourceRead(run.target!, run.owner.id, {
    credential: run.credential,
    tool: "google_mail_thread",
    result: { text: partial.text },
    items: [partial],
  });
  options.decide = (input) => {
    expect(input.trigger).toBe("source_read");
    const evidence = input.evidence.find(
      (source) => source.text === partial.text
    )!;
    return [
      {
        ...threadUpdate(input),
        attention: "none",
        message: "",
        checks: [
          {
            id: original.id,
            text: "Confirm the apartment and booking",
            evidence: evidence.id,
            quote: partial.text,
            at: null,
            afterDays: null,
          },
        ],
      },
    ];
  };
  // A restart retains the pending observation, independently of the agent session.
  const pending = app.app.database
    .query(
      "SELECT count(*) n FROM intake_source_read WHERE assessed_at IS NULL"
    )
    .get();
  expect(pending).toEqual({ n: 1 });
  await run.restart();
  await intake.tick(START + 60_000);
  const remaining = intake.openChecks(run.workspaceId, run.owner);
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toMatchObject({
    id: original.id,
    text: "Confirm the apartment and booking",
    deadlineAt: original.deadlineAt,
  });
  expect(remaining[0]!.sourceIds).toHaveLength(2);
  expect(run.reviews).toHaveLength(0);
});

test("a failed source-read assessment stays pending with backoff and resumes after restart", async () => {
  const options: Parameters<typeof setup>[0] = { target: "private" };
  const run = await setup(options);
  await intake.tick(START);
  const reply = item(
    "found-reply",
    "Here is the substantive response. Repairs start Monday.",
    false,
    START
  );
  intake.recordSourceRead(run.target!, run.owner.id, {
    credential: run.credential,
    tool: "google_mail_thread",
    result: {},
    items: [reply],
  });
  let attempts = 0;
  options.decide = () => {
    attempts += 1;
    throw new Error("Judge unavailable");
  };
  await intake.tick(START + 60_000);
  await intake.tick(START + 120_000);
  // The new reply's normal assessment and the read's own check each failed once, then wait.
  expect(attempts).toBe(2);
  expect(intake.openChecks(run.workspaceId, run.owner)).toHaveLength(1);
  expect(
    app.app.database
      .query(
        "SELECT count(*) n FROM intake_source_read WHERE assessed_at IS NULL"
      )
      .get()
  ).toEqual({ n: 1 });
  options.decide = undefined;
  await run.restart();
  await intake.tick(START + 180_000);
  expect(intake.openChecks(run.workspaceId, run.owner)).toHaveLength(0);
  expect(run.reviews).toHaveLength(0);
});

test("opting out pauses queued source reads and another account cannot inject evidence", async () => {
  const run = await setup({ target: "private" });
  await intake.tick(START);
  const reply = item(
    "read-reply",
    "Here is the substantive response. Repairs start Monday.",
    false,
    START
  );
  const read = {
    credential: run.credential,
    tool: "google_mail_thread",
    result: {},
    items: [reply],
  };
  intake.recordSourceRead(run.target!, run.owner.id, {
    ...read,
    credential: { ...run.credential, id: "other-account" },
  });
  expect(
    app.app.database.query("SELECT count(*) n FROM intake_source_read").get()
  ).toEqual({ n: 0 });
  intake.recordSourceRead(run.target!, run.owner.id, read);
  run.enable(false);
  await intake.tick(START + 60_000);
  expect(
    app.app.database
      .query(
        "SELECT count(*) n FROM intake_source_read WHERE assessed_at IS NULL"
      )
      .get()
  ).toEqual({ n: 1 });
  run.enable(true);
  await intake.tick(START + 120_000);
  expect(intake.openChecks(run.workspaceId, run.owner)).toHaveLength(0);
});

test.each(["slack", "whatsapp", "google"] as const)(
  "a normal request and the owner's reply an hour later stay silent (%s)",
  async (source) => {
    const run = await setup({
      source,
      target: "private",
      actualReview: true,
      decide: (input) => [threadUpdate(input)],
    });
    const incoming = {
      ...item("draft", "Can you review the draft?", false, START),
      chat: "draft-discussion",
    };
    run.items([incoming]);
    await intake.tick(START + 1000);
    expect(run.reviews).toHaveLength(1);
    // The update is posted in the thread, and no agent starts on it.
    const last = (await app.app.threads.messages(run.target!)).messages.at(-1)!;
    expect(last).toMatchObject({ observation: true });
    expect(last.text).toContain("Keep the useful context");
    expect(
      app.app.notifications.inbox(run.workspaceId, run.owner).notifications
    ).toHaveLength(0);
    run.items([
      incoming,
      {
        ...item("done", "Handled", true, START + 60 * 60_000),
        chat: incoming.chat,
      },
    ]);
    await intake.tick(START + 60 * 60_000);
    await intake.tick(Date.parse("2026-10-02T08:00:00+02:00"));
    expect(
      app.app.notifications.inbox(run.workspaceId, run.owner).notifications
    ).toHaveLength(0);
    expect(intake.openChecks(run.workspaceId, run.owner)).toHaveLength(0);
    expect(
      run.snapshots.some((input) => input.trigger === "notification")
    ).toBe(false);
  }
);

test("an owner reply after the update is posted suppresses a proposed push and keeps the update", async () => {
  const run = await setup({
    source: "slack",
    target: "private",
    actualReview: true,
    decide: (input) => {
      const update = threadUpdate(input);
      const reply = input.evidence.find(
        (source) => source.text === "Here is the repair plan."
      );
      const handled = input.evidence.some(
        (source) => source.fromOwner && source.text === "Handled"
      );
      if (reply && !handled) {
        update.notification = {
          kind: "awaited_reply",
          reason: "The awaited plan needs review",
          evidence: reply.id,
          quote: reply.text,
        };
      }
      return [update];
    },
  });
  const reply = {
    ...item("plan", "Here is the repair plan.", false, START),
    chat: "claim-discussion",
  };
  run.items([reply]);
  // The owner answers right after the update reaches the thread, before the push is checked.
  postHook = () =>
    run.items([
      reply,
      { ...item("handled", "Handled", true, START + 1000), chat: reply.chat },
    ]);
  await intake.tick(START + 1000);
  const recheck = run.snapshots.find(
    (input) => input.trigger === "notification"
  )!;
  expect(
    recheck.evidence.some(
      (source) => source.fromOwner && source.text === "Handled"
    )
  ).toBe(true);
  expect(
    app.app.notifications.inbox(run.workspaceId, run.owner).notifications
  ).toHaveLength(0);
  expect(
    (await app.app.threads.messages(run.target!)).messages.at(-1)
  ).toMatchObject({ observation: true });
  expect(
    intake.audit.database
      .query(
        "SELECT count(*) n FROM event WHERE stage='notification.suppressed'"
      )
      .get()
  ).toMatchObject({ n: 1 });
});

test("a silent useful due review leaves the later notification eligible", async () => {
  const options = { target: "private" as const, silent: true };
  const run = await setup(options);
  await intake.tick(START + 1000);
  const deadline = intake.openChecks(run.workspaceId, run.owner)[0]!.checkAt;
  await intake.tick(deadline + 1000);
  expect(run.reviews).toHaveLength(1);
  expect(
    app.app.notifications.inbox(run.workspaceId, run.owner).notifications
  ).toHaveLength(0);
  const review = intake.openChecks(run.workspaceId, run.owner)[0]!;
  expect(review.notifiedAt).toBeNull();
  options.silent = false;
  await intake.tick(review.reviewAt + 1000);
  expect(
    app.app.notifications.inbox(run.workspaceId, run.owner).notifications
  ).toHaveLength(1);
  expect(
    intake.openChecks(run.workspaceId, run.owner)[0]!.notifiedAt
  ).not.toBeNull();
});

test("a source outage after the update is posted postpones the push; restart retries without a second post or notice", async () => {
  const run = await setup({
    target: "private",
    actualReview: true,
    decide: (input) => {
      const update = threadUpdate(input);
      const reply = input.evidence.find(
        (source) => source.text === "Here is the repair plan."
      )!;
      update.notification = {
        kind: "awaited_reply",
        reason: "The awaited plan needs review",
        evidence: reply.id,
        quote: reply.text,
      };
      return [update];
    },
  });
  run.items([item("plan", "Here is the repair plan.", false, START)]);
  // One outage, right after the first post.
  postHook = () => {
    run.outage();
    postHook = undefined;
  };
  await intake.tick(START + 1000);
  expect(
    app.app.notifications.inbox(run.workspaceId, run.owner).notifications
  ).toHaveLength(0);
  expect(
    app.app.database
      .query(
        "SELECT count(*) n FROM intake_delivery WHERE delivered_at IS NULL AND notification IS NOT NULL"
      )
      .get()
  ).toMatchObject({ n: 1 });
  run.recover();
  await run.restart();
  await intake.tick(START + 16 * 60_000);
  expect(
    app.app.notifications.inbox(run.workspaceId, run.owner).notifications
  ).toHaveLength(1);
  const { messages } = await app.app.threads.messages(run.target!);
  expect(messages.filter((message) => message.observation)).toHaveLength(1);
  await intake.tick(START + 32 * 60_000);
  expect(
    app.app.notifications.inbox(run.workspaceId, run.owner).notifications
  ).toHaveLength(1);
});

test.each(["private", "shared", "new", "hidden-name", "shared-name"] as const)(
  "a new conference gets a subject thread and source files in a private channel of the owner (%s)",
  async (destination) => {
    const run = await setup({
      actualReview: true,
      decide: (input) => {
        const thread = input.threads.find(
          (each) => each.title === "Autumn conference"
        );
        const channel = input.channels.find(
          (each) => each.name === "events" && destination !== "shared-name"
        );
        const invitation = input.evidence.find((each) =>
          each.text.includes("Registration opens")
        );
        let notification: Assessment["notification"] = null;
        if (
          input.trigger === "notification" ||
          input.trigger === "destination"
        ) {
          notification = input.pendingNotifications?.[0] ?? null;
        } else if (invitation && input.newEvidenceIds.includes(invitation.id)) {
          notification = {
            kind: "time_sensitive",
            reason: "The conference starts today and preparation helps now",
            evidence: invitation.id,
            quote: invitation.text,
          };
        }
        return [
          {
            threadId: thread?.id ?? null,
            startThread: !thread,
            channelId: thread ? null : (channel?.id ?? null),
            newChannel:
              thread || channel
                ? null
                : {
                    name: "events",
                    summary: "Events, programmes, and tickets",
                  },
            title: "Autumn conference",
            summary:
              "The autumn conference starts today. The ticket is available.",
            attention: "now",
            notification,
            message:
              "Your conference starts today. Here are the useful details.",
            evidence: input.newEvidenceIds.length
              ? input.newEvidenceIds
              : input.evidence.map((each) => each.id),
            checks: [],
            resolved: [],
          },
        ];
      },
    });
    await app.signIn("Bob", "bob@example.com");
    const { internalAdapter } = await app.app.auth.$context;
    const bob = (await internalAdapter.findUserByEmail("bob@example.com"))!
      .user;
    await app.app.workspaces.addMember(run.workspaceId, run.owner, bob.email);
    const previous =
      destination === "new"
        ? null
        : app.app.workspaces.createChannel(
            run.workspaceId,
            destination === "hidden-name" ? bob : run.owner,
            "events",
            destination !== "shared" && destination !== "shared-name"
          );
    app.faux.setResponses(
      Array.from(
        { length: 30 },
        () => () =>
          fauxAssistantMessage(
            "Your conference starts today. The programme is attached."
          )
      )
    );
    const invitation = item(
      "invitation",
      "The autumn conference starts today. Registration opens at 07:30. Your ticket is in an earlier email.",
      false,
      START,
      [
        {
          id: "programme",
          name: "programme.ics",
          type: "text/calendar",
          size: 30,
        },
      ]
    );
    run.items([invitation]);
    await intake.tick(START + 1000);
    expect(run.reviews).toHaveLength(1);
    const thread = app.app.workspaces.thread(
      run.reviews[0]!.threadId,
      run.owner
    );
    const channel = app.app.workspaces.channel(
      run.workspaceId,
      thread.channelId,
      run.owner
    );
    if (destination === "private") {
      expect(channel.id).toBe(previous!.id);
    } else {
      // A channel that others see is never offered for a new matter of the owner's sources.
      expect(channel.ownerId).toBe(run.owner.id);
      expect(channel.name).toBe(destination === "new" ? "events" : "events-2");
      expect(channel.summary).toBe("Events, programmes, and tickets");
      expect(
        run.snapshots[0]!.channels.some((each) => each.id === previous?.id)
      ).toBe(false);
    }
    const source = (await app.app.threads.messages(thread)).messages.find(
      (message) => message.observation
    )!;
    expect(source.files).toHaveLength(2);
    expect(
      source.files.some((file) => file.name.endsWith("programme.ics"))
    ).toBe(true);
    const archived = app.app.database
      .query("SELECT thread_id FROM intake_item WHERE source_id='invitation'")
      .get() as { thread_id: string };
    expect(archived.thread_id).toBe(thread.id);
    const { path } = await app.app.threads.file(
      run.workspaceId,
      run.owner,
      source.files[0]!.id
    );
    expect(await Bun.file(path).text()).toContain(
      "Your ticket is in an earlier email"
    );
    await expect(
      app.app.threads.file(run.workspaceId, bob, source.files[0]!.id)
    ).rejects.toThrow();
    expect(
      app.app.notifications.inbox(run.workspaceId, run.owner).notifications
    ).toEqual([expect.objectContaining({ threadId: thread.id })]);
    expect(
      app.app.notifications.inbox(run.workspaceId, bob).notifications
    ).toHaveLength(0);
    const count = app.app.workspaces.threadsIn(
      run.workspaceId,
      run.owner.id
    ).length;
    app.app.database
      .query(
        "UPDATE intake_item SET assessed_at=NULL WHERE source_id='invitation'"
      )
      .run();
    await run.restart();
    await intake.tick(START + 16 * 60_000);
    expect(run.reviews).toHaveLength(1);
    run.items([
      invitation,
      item(
        "ticket",
        "Your ticket for the autumn conference.",
        false,
        START + 17 * 60_000
      ),
    ]);
    await intake.tick(START + 32 * 60_000);
    expect(
      run.snapshots.at(-1)!.threads.some((each) => each.id === thread.id)
    ).toBe(true);
    expect(run.reviews.map((review) => review.threadId)).toEqual([
      thread.id,
      thread.id,
    ]);
    expect(
      app.app.workspaces.threadsIn(run.workspaceId, run.owner.id)
    ).toHaveLength(count);
    expect(
      app.app.workspaces
        .channelsIn(run.workspaceId, run.owner.id)
        .some((each) => each.name.startsWith("sources-"))
    ).toBe(false);
  }
);

test("a stated response period survives restart and triggers once after 30 calendar days", async () => {
  const run = await setup();
  await intake.tick(START + 1000);
  const [check] = intake.openChecks(run.workspaceId, run.owner);
  expect(check!.checkAt).toBe(afterCalendarDays(START, 30));
  expect(run.deliveries).toHaveLength(0);
  await run.restart();
  expect(intake.openChecks(run.workspaceId, run.owner)[0]?.checkAt).toBe(
    check!.checkAt
  );
  await intake.tick(check!.checkAt + 1000);
  expect(run.deliveries).toHaveLength(1);
  await intake.tick(check!.checkAt + 4 * DAY);
  expect(run.deliveries).toHaveLength(1);
  expect(intake.openChecks(run.workspaceId, run.owner)).toHaveLength(1);
  expect(
    intake.audit.database
      .query("SELECT count(*) n FROM event WHERE stage='model.request'")
      .get()
  ).toMatchObject({ n: run.assessments() });
});

test("an acknowledgement keeps a check open; a substantive reply in a different conversation resolves it", async () => {
  const run = await setup();
  await intake.tick(START + 1000);
  run.items([
    item(
      "ack",
      "We received your request and will respond.",
      false,
      START + DAY
    ),
  ]);
  await intake.tick(START + DAY);
  expect(intake.openChecks(run.workspaceId, run.owner)).toHaveLength(1);
  run.items([
    item(
      "reply",
      "Here is the substantive response. Repairs start Monday.",
      false,
      START + 2 * DAY
    ),
  ]);
  await intake.tick(START + 2 * DAY);
  expect(intake.openChecks(run.workspaceId, run.owner)).toHaveLength(0);
  await intake.tick(START + 31 * DAY);
  expect(run.deliveries).toHaveLength(0);
});

test("a collection failure preserves coverage and produces a verification gap rather than a false no-reply claim", async () => {
  const run = await setup();
  await intake.tick(START + 1000);
  run.outage();
  await intake.tick(START + 31 * DAY);
  expect(run.deliveries[0]).toContain("could not verify");
  expect(run.snapshots.at(-1)!.coverage[0]!.error).toContain("disconnected");
});

test("unchanged polls start neither local nor large model work", async () => {
  const run = await setup();
  await intake.tick(START + 1000);
  const calls = run.assessments();
  await intake.tick(START + 16 * 60_000);
  expect(run.assessments()).toBe(calls);
});

test("an earlier update does not consume the future deadline notification", async () => {
  const run = await setup({ initialNotice: "now" });
  await intake.tick(START + 1000);
  expect(run.deliveries).toHaveLength(1);
  expect(
    intake.openChecks(run.workspaceId, run.owner)[0]!.notifiedAt
  ).toBeNull();
  await intake.tick(START + 31 * DAY);
  expect(run.deliveries).toHaveLength(2);
});

test("passive observations start no model and retry without duplicate messages or notifications", async () => {
  const run = await setup();
  const thread = await app.app.threads.orchestrator(run.workspaceId, run.owner);
  const before = app.faux.state.callCount;
  await app.app.threads.observe(
    thread,
    "The response period passed.",
    "stable-finding",
    run.owner,
    true
  );
  await app.app.threads.observe(
    thread,
    "The response period passed.",
    "stable-finding",
    run.owner,
    true
  );
  const state = await app.app.threads.messages(thread);
  expect(state.messages.filter((message) => message.observation)).toHaveLength(
    1
  );
  expect(state.running).toBe(false);
  expect(app.faux.state.callCount).toBe(before);
  expect(
    app.app.notifications.inbox(run.workspaceId, run.owner).notifications
  ).toHaveLength(1);
});

test("a source observation can start a shared family subject without running a model or sending a notification", async () => {
  const run = await setup({ target: "shared" });
  const before = app.faux.state.callCount;
  await app.app.threads.observe(
    run.target!,
    "A new source concerns this family subject.",
    "shared-source",
    run.owner,
    false
  );
  const state = await app.app.threads.messages(run.target!);
  expect(state.messages.filter((message) => message.observation)).toHaveLength(
    1
  );
  expect(state.running).toBe(false);
  expect(app.faux.state.callCount).toBe(before);
  expect(
    app.app.notifications.inbox(run.workspaceId, run.owner).notifications
  ).toHaveLength(0);
});

test("private source reads and corrections require membership and never return another person's records", async () => {
  const run = await setup();
  await intake.tick(START + 1000);
  await app.signIn("Bob", "bob@example.com");
  const { internalAdapter } = await app.app.auth.$context;
  const bob = (await internalAdapter.findUserByEmail("bob@example.com"))!.user;
  app.app.database
    .query(
      "INSERT OR IGNORE INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,'member',?)"
    )
    .run("bob-member", run.workspaceId, bob.id, Date.now());
  expect(intake.status(run.workspaceId, bob).evidence).toHaveLength(0);
  const privateThread = await app.app.threads.orchestrator(
    run.workspaceId,
    run.owner
  );
  await expect(
    app.app.threads.observe(
      privateThread,
      "Private source",
      "foreign-source",
      bob,
      false
    )
  ).rejects.toMatchObject({ status: 404 });
  expect(intake.openChecks(run.workspaceId, bob)).toHaveLength(0);
  const check = intake.openChecks(run.workspaceId, run.owner)[0]!;
  await expect(
    intake.following.change(run.workspaceId, bob, check.id, {
      action: "handled",
      revision: 1,
      quote: "handled",
    })
  ).rejects.toMatchObject({ status: 404 });
  expect(() => intake.status("another-workspace", run.owner)).toThrow();
});

test("a request resolved during the day cancels its queued morning notice", async () => {
  const run = await setup({ initialNotice: "brief" });
  await intake.tick(START + 1000);
  expect(run.deliveries).toHaveLength(0);
  run.items([
    item(
      "reply",
      "Here is the substantive response. Repairs start Monday.",
      false,
      START + 5 * 60 * 60_000
    ),
  ]);
  await intake.tick(START + 5 * 60 * 60_000);
  await intake.tick(Date.parse("2026-10-02T08:00:00+02:00"));
  expect(run.deliveries).toHaveLength(0);
});

test("turning off an account stops its queued notices and future checks", async () => {
  const run = await setup({ initialNotice: "brief" });
  await intake.tick(START + 1000);
  run.enable(false);
  await intake.tick(Date.parse("2026-10-02T08:00:00+02:00"));
  await intake.tick(START + 31 * DAY);
  expect(run.deliveries).toHaveLength(0);
  expect(intake.status(run.workspaceId, run.owner).evidence).toHaveLength(0);
  expect(intake.openChecks(run.workspaceId, run.owner)).toHaveLength(0);
});

test("current recall replaces an edited source and retains its earlier version for audit", async () => {
  const run = await setup();
  await intake.tick(START + 1000);
  run.items([item("request", "The claim has been withdrawn.", true, START)]);
  await intake.tick(START + 16 * 60_000);
  const current = intake.status(run.workspaceId, run.owner).evidence;
  expect(current).toHaveLength(1);
  expect(current[0]!.text).toBe("The claim has been withdrawn.");
  expect(
    app.app.database.query("SELECT count(*) n FROM intake_item").get()
  ).toMatchObject({ n: 2 });
  expect(
    app.app.database
      .query(
        "SELECT count(*) n FROM intake_item WHERE superseded_at IS NOT NULL"
      )
      .get()
  ).toMatchObject({ n: 1 });
});

test("the morning review posts one message to the thread without an agent run, then a summary that notifies", async () => {
  const run = await setup({ initialNotice: "brief" });
  await intake.tick(START + 1000);
  await intake.tick(Date.parse("2026-10-02T08:00:00+02:00"));
  // The one post to the thread; no agent runs.
  expect(run.reviews).toHaveLength(1);
  expect(run.plans).toHaveLength(1);
  const [post, summary] = run.posts;
  expect(post).toMatchObject({ notify: false });
  expect(post!.text).toContain("repair claim");
  expect(post!.files).toHaveLength(1);
  const orchestrator = await app.app.threads.orchestrator(
    run.workspaceId,
    run.owner
  );
  expect(summary).toMatchObject({ threadId: orchestrator.id, notify: true });
  expect(summary!.text).toContain(`(thread:${post!.threadId})`);
  expect(
    app.app.database.query("SELECT delivered_at FROM intake_delivery").get()
  ).toMatchObject({ delivered_at: expect.any(Number) });
  // One review a day.
  await intake.tick(Date.parse("2026-10-02T08:01:00+02:00"));
  expect(run.posts).toHaveLength(2);
  expect(run.plans).toHaveLength(1);
});

test("the morning review puts the updates of one matter into one new thread, starts no agent, and nudges what it asks every 2 days until it is handled", async () => {
  const run = await setup({
    decide: (input) =>
      input.newEvidenceIds.map((id, index) => ({
        ...proposedSubject(
          input,
          index === 0 ? "OpenSearch logs" : "OpenSearch memory peaks"
        ),
        evidence: [id],
      })),
    plan: (input) => ({
      summary: "One matter today",
      topics: [
        {
          updates: input.updates.map((update) => update.id),
          threadId: null,
          title: "OpenSearch incident",
          ...newThreadPlace(input),
          message: "Francisco sent the logs and the memory peaks [1][2].",
          ask: "Reply to Francisco about the diagnostics",
          due: null,
          line: "Francisco sent the OpenSearch diagnostics",
        },
      ],
      dropped: [],
    }),
  });
  run.items([
    item("logs", "Here are the Docker logs.", false, START),
    item("peaks", "Memory peaks attached.", false, START),
  ]);
  await intake.tick(START);
  expect(subjectThreads(run)).toHaveLength(0);
  await intake.tick(Date.parse("2026-10-02T08:00:00+02:00"));
  const threads = subjectThreads(run);
  expect(threads.map((thread) => thread.title)).toEqual([
    "OpenSearch incident",
  ]);
  expect(run.reviews).toHaveLength(1);
  expect(run.reviews[0]).toMatchObject({ threadId: threads[0]!.id });
  expect(run.reviews[0]!.text).toContain("Francisco sent the logs");
  expect(run.reviews[0]!.files).toHaveLength(2);
  const summary = run.posts.at(-1)!;
  expect(summary.notify).toBe(true);
  expect(summary.text).toContain("One matter today");
  expect(
    intake.openChecks(run.workspaceId, run.owner).map((each) => each.text)
  ).toContain("Reply to Francisco about the diagnostics");

  // The next morning has nothing new; the second morning after nudges what the matter asks.
  const posted = run.posts.length;
  await intake.tick(Date.parse("2026-10-03T08:00:00+02:00"));
  expect(run.posts).toHaveLength(posted);
  await intake.tick(Date.parse("2026-10-04T08:00:00+02:00"));
  expect(run.posts).toHaveLength(posted + 1);
  expect(run.posts.at(-1)!.text).toContain(
    `[OpenSearch incident](thread:${threads[0]!.id}): Reply to Francisco about the diagnostics`
  );
  expect(run.posts.at(-1)!.notify).toBe(true);

  // Once the person says it is done, it is never nudged again.
  const check = intake
    .openChecks(run.workspaceId, run.owner)
    .find((each) => each.text.startsWith("Reply to Francisco"))!;
  const [listed] = intake.following
    .list(run.workspaceId, run.owner)
    .filter((each) => each.id === check.id);
  await intake.following.change(run.workspaceId, run.owner, check.id, {
    action: "handled",
    revision: listed!.revision,
    quote: "Done, I replied from my laptop",
  });
  await intake.tick(Date.parse("2026-10-06T08:00:00+02:00"));
  expect(run.posts).toHaveLength(posted + 1);
});

test("a morning plan that leaves an update out changes nothing and is tried again", async () => {
  let complete = false;
  const run = await setup({
    initialNotice: "brief",
    plan: (input) => ({
      summary: "Morning",
      topics: complete
        ? [
            {
              updates: [input.updates[0]!.id],
              threadId: input.updates[0]!.threadId,
              title: input.updates[0]!.proposedTitle ?? "Balcony claim",
              ...(input.updates[0]!.threadId
                ? { channelId: null, newChannel: null }
                : newThreadPlace(input)),
              message: "The claim waits.",
              ask: null,
              due: null,
              line: "The claim waits",
            },
          ]
        : [],
      dropped: [],
    }),
  });
  await intake.tick(START + 1000);
  await intake.tick(Date.parse("2026-10-02T08:00:00+02:00"));
  expect(run.posts).toHaveLength(0);
  expect(
    app.app.database.query("SELECT delivered_at FROM intake_delivery").get()
  ).toMatchObject({ delivered_at: null });
  complete = true;
  await intake.tick(Date.parse("2026-10-02T08:16:00+02:00"));
  expect(run.posts).toHaveLength(2);
});

test("after two failed morning plans, each update is posted alone", async () => {
  const run = await setup({
    initialNotice: "brief",
    plan: () => ({ summary: "Broken", topics: [], dropped: [] }),
  });
  await intake.tick(START + 1000);
  await intake.tick(Date.parse("2026-10-02T08:00:00+02:00"));
  await intake.tick(Date.parse("2026-10-02T08:16:00+02:00"));
  expect(run.posts).toHaveLength(0);
  // The second failure waits twice as long.
  await intake.tick(Date.parse("2026-10-02T08:32:00+02:00"));
  expect(run.posts).toHaveLength(0);
  await intake.tick(Date.parse("2026-10-02T08:47:00+02:00"));
  expect(run.plans).toHaveLength(2);
  const [post, summary] = run.posts;
  expect(post!.text).toContain("repair claim");
  expect(summary!.notify).toBe(true);
});

test("a morning summary that failed is sent at the next try, once", async () => {
  let reachable = false;
  const run = await setup({
    initialNotice: "brief",
    postFails: (threadId) =>
      !reachable &&
      app.app.workspaces
        .threadsIn(run.workspaceId, run.owner.id)
        .some((thread) => thread.id === threadId && thread.ownerId !== null),
  });
  await intake.tick(START + 1000);
  await intake.tick(Date.parse("2026-10-02T08:00:00+02:00"));
  expect(run.posts.map((post) => post.notify)).toEqual([false]);
  reachable = true;
  await intake.tick(Date.parse("2026-10-02T08:16:00+02:00"));
  expect(run.posts.map((post) => post.notify)).toEqual([false, true]);
  expect(run.posts[1]!.text).toContain(`(thread:${run.posts[0]!.threadId})`);
  await intake.tick(Date.parse("2026-10-02T08:32:00+02:00"));
  expect(run.posts).toHaveLength(2);
});

test("intake_read gives every waiting update whatever the query, and reading leaves it waiting", async () => {
  const run = await setup({ initialNotice: "brief" });
  await intake.tick(START + 1000);
  const read = intake
    .tools(run.workspaceId)
    .find((tool) => tool.name === "intake_read")!;
  const result = await read.execute(
    { query: "something unrelated" } as never,
    { conversationId: 1 } as never,
    undefined as never
  );
  const { waiting } = JSON.parse(
    (result.output![0] as { text: string }).text
  ) as { waiting: { id: string; posts: string; message: string }[] };
  const [update] = intake.following
    .overview(run.workspaceId, run.owner)
    .updates.filter((each) => each.deliveredAt === null);
  expect(waiting).toMatchObject([
    { id: update!.id, posts: "at the 08:00 review", message: update!.body },
  ]);
  expect(
    app.app.database
      .query(
        "SELECT delivered_at, cancelled_at FROM intake_delivery WHERE id=?"
      )
      .get(update!.id)
  ).toEqual({ delivered_at: null, cancelled_at: null });
});

test("the overview shows a waiting update, takes feedback for the judge, and can post the update now", async () => {
  const run = await setup({ initialNotice: "brief" });
  await intake.tick(START + 1000);
  const overview = intake.following.overview(run.workspaceId, run.owner);
  expect(overview.sources).toHaveLength(1);
  expect(overview.sources[0]!.readAt).not.toBeNull();
  expect(overview.sources[0]!.kept).toBeGreaterThan(0);
  expect(overview.kept.length).toBeGreaterThan(0);
  const [update] = overview.updates;
  expect(update).toMatchObject({ attention: "brief", deliveredAt: null });
  expect(update!.evidence.length).toBeGreaterThan(0);
  const feedback = intake.following.feedback(
    run.workspaceId,
    run.owner,
    `update:${update!.id}`,
    "Updates about this claim can go to the thread at once"
  );
  expect(
    intake.following.overview(run.workspaceId, run.owner).feedback
  ).toEqual([feedback]);
  expect(
    intake.following
      .corrections(run.workspaceId, run.owner)
      .some(
        (each) => each.state === "feedback" && each.quote === feedback.quote
      )
  ).toBe(true);
  expect(() =>
    intake.following.feedback(run.workspaceId, run.owner, "item:none", "Wrong")
  ).toThrow();
  intake.following.changeUpdate(run.workspaceId, run.owner, update!.id, "now");
  await intake.tick(START + 2 * 60_000);
  expect(run.deliveries).toHaveLength(1);
  expect(() =>
    intake.following.changeUpdate(
      run.workspaceId,
      run.owner,
      update!.id,
      "cancel"
    )
  ).toThrow();
});

test("deleting a waiting update blocks its sender, deletes what intake read from them, and reads nothing more from them", async () => {
  const run = await setup({
    target: "shared",
    decide: (input) => [{ ...threadUpdate(input), attention: "brief" }],
  });
  run.items([
    {
      ...item("spam", "You won a prize", false, START),
      sender: "Prize Team <Prizes@Example.com>",
    },
  ]);
  await intake.tick(START + 1000);
  const waiting = () =>
    intake.following
      .overview(run.workspaceId, run.owner)
      .updates.filter(
        (each) => each.deliveredAt === null && each.cancelledAt === null
      );
  const kept = () =>
    intake.following
      .overview(run.workspaceId, run.owner)
      .kept.map((each) => each.text);
  const [update] = waiting();
  expect(kept()).toContain("You won a prize");
  await intake.deleteUpdate(run.workspaceId, run.owner, update!.id);
  expect(waiting()).toEqual([]);
  expect(kept()).not.toContain("You won a prize");
  const { blocked } = intake.following.overview(run.workspaceId, run.owner);
  expect(blocked).toMatchObject([
    { kind: "sender", label: "Prize Team <Prizes@Example.com>" },
  ]);
  await expect(
    intake.deleteUpdate(run.workspaceId, run.owner, update!.id)
  ).rejects.toThrow();

  // A new message from the same address, in another conversation, is never assessed or kept.
  const assessed = run.assessments();
  run.items([
    {
      ...item("spam-2", "Another prize", false, START + 60_000),
      sender: "prizes@example.com",
    },
  ]);
  await intake.tick(START + 20 * 60_000);
  expect(run.assessments()).toBe(assessed);
  expect(kept()).not.toContain("Another prize");
  // It is kept as deleted, so the source does not give it again.
  expect(
    app.app.database
      .query(
        "SELECT source_id, deleted_at IS NOT NULL AS deleted FROM intake_item WHERE owner_id=? AND source_id LIKE 'spam%' ORDER BY source_id"
      )
      .all(run.owner.id)
  ).toEqual([
    { source_id: "spam", deleted: 1 },
    { source_id: "spam-2", deleted: 1 },
  ]);

  // Unblocking lets intake read the sender again; what it deleted stays deleted.
  intake.following.unblock(run.workspaceId, run.owner, blocked[0]!.id);
  expect(intake.following.overview(run.workspaceId, run.owner).blocked).toEqual(
    []
  );
  expect(kept()).not.toContain("You won a prize");
  expect(() =>
    intake.following.unblock(run.workspaceId, run.owner, blocked[0]!.id)
  ).toThrow("Not found");
});

test("deleting a chat update from a contact with no name blocks only that chat, never the owner's own messages", async () => {
  const run = await setup({
    source: "whatsapp",
    target: "shared",
    decide: (input) => [{ ...threadUpdate(input), attention: "brief" }],
  });
  run.items([
    {
      ...item("unknown", "Buy cheap followers", false, START),
      chat: "unknown-contact",
      sender: "",
    },
    {
      ...item("mine", "I will bring the cake", true, START),
      chat: "family",
      sender: "",
    },
  ]);
  await intake.tick(START + 1000);
  const update = intake.following
    .overview(run.workspaceId, run.owner)
    .updates.find((each) => each.deliveredAt === null)!;
  await intake.deleteUpdate(run.workspaceId, run.owner, update.id);
  const overview = intake.following.overview(run.workspaceId, run.owner);
  expect(overview.blocked).toMatchObject([{ kind: "chat" }]);
  expect(overview.kept.map((each) => each.text)).toContain(
    "I will bring the cake"
  );
  expect(overview.kept.map((each) => each.text)).not.toContain(
    "Buy cheap followers"
  );
});

test("the owner's own message in a shared thread takes its waiting update once; another member's does not", async () => {
  const run = await setup({
    target: "shared",
    decide: (input) => [{ ...threadUpdate(input), attention: "brief" }],
  });
  await intake.tick(START + 1000);
  const threadId = run.target!.id;
  const waiting = () =>
    app.app.database
      .query(
        "SELECT count(*) AS n FROM intake_delivery WHERE thread_id=? AND delivered_at IS NULL"
      )
      .get(threadId) as { n: number };
  expect(waiting().n).toBe(1);
  const otherToken = await app.signIn("Bob", "bob@example.com");
  const other = (await (
    await app.call("/api/v1/me", { token: otherToken })
  ).json()) as { user: typeof run.owner };
  app.app.database
    .query(
      "INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,'member',?)"
    )
    .run("claim-bob", run.workspaceId, other.user.id, Date.now());
  expect(
    intake.contextFor(run.workspaceId, threadId, other.user.id, true)
  ).not.toContain("30 days");
  expect(waiting().n).toBe(1);
  const context = intake.contextFor(
    run.workspaceId,
    threadId,
    run.owner.id,
    true
  );
  expect(context).toContain("newFromWatchedAccounts");
  expect(context).toContain("within 30 days");
  // Taken, but delivered only once the turn answers: a turn that fails or starts again takes it again.
  expect(waiting().n).toBe(1);
  expect(
    intake.contextFor(run.workspaceId, threadId, run.owner.id, true)
  ).toContain("newFromWatchedAccounts");
  // No delivery posts it while the turn runs.
  await intake.tick(Date.parse("2026-10-02T08:00:00+02:00"));
  expect(run.deliveries).toHaveLength(0);
  intake.finishClaims(run.workspaceId, threadId, run.owner.id);
  expect(waiting().n).toBe(0);
  expect(
    intake.contextFor(run.workspaceId, threadId, run.owner.id, true)
  ).not.toContain("newFromWatchedAccounts");
});

test("the JSON API scopes source reads and validates corrections", async () => {
  const run = await setup();
  await intake.tick(START + 1000);
  const base = `/api/v1/workspaces/${run.workspaceId}/intake`;
  const { handler, dispose } = HttpRouter.toWebHandler(
    routes({ ...app.app, intake }, intakeApiRoutes),
    { disableLogger: true }
  );
  const call: typeof app.call = (path, options = {}) =>
    handler(
      new Request(`http://golem.test${path}`, {
        method: options.body === undefined ? "GET" : "POST",
        headers: {
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          "content-type": "application/json",
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    );
  expect((await call(base)).status).toBe(401);
  const response = await call(base, { token: run.token });
  expect(response.status).toBe(200);
  expect(
    ((await response.json()) as { evidence: unknown[] }).evidence
  ).toHaveLength(1);
  const [check] = intake.openChecks(run.workspaceId, run.owner);
  const followingBase = `/api/v1/workspaces/${run.workspaceId}/following`;
  expect((await call(followingBase)).status).toBe(401);
  const ledger = (await (
    await call(followingBase, { token: run.token })
  ).json()) as { checks: { id: string; revision: number }[] };
  expect(ledger.checks[0]!.id).toBe(check!.id);
  const corrected = await call(`${followingBase}/${check!.id}`, {
    token: run.token,
    body: {
      action: "correct",
      quote: "Wait until November",
      revision: "invalid",
    },
  });
  expect(corrected.status).toBe(400);
  const outsider = await app.signIn("Eve", "eve@example.com");
  expect((await call(base, { token: outsider })).status).toBe(404);
  expect(
    (
      await call(`${followingBase}/${check!.id}`, {
        token: run.token,
        body: {
          action: "handled",
          revision: ledger.checks[0]!.revision,
          quote: "Handled offline",
        },
      })
    ).status
  ).toBe(200);
  expect(intake.openChecks(run.workspaceId, run.owner)).toHaveLength(0);
  const detail = (await (
    await call(`${followingBase}/${check!.id}`, { token: run.token })
  ).json()) as { check: { state: string }; history: { quote: string }[] };
  expect(detail.check.state).toBe("resolved");
  expect(detail.history[0]!.quote).toBe("Handled offline");
  expect(
    (
      await call(`${followingBase}/${check!.id}`, {
        token: run.token,
        body: {
          action: "stop",
          quote: "Stale edit",
          revision: ledger.checks[0]!.revision,
        },
      })
    ).status
  ).toBe(409);
  await dispose();
});

test("a context-only revision keeps the original stated time and evidence", async () => {
  const run = await setup();
  await intake.tick(START + 1000);
  const [check] = intake.openChecks(run.workspaceId, run.owner);
  saveCheck(
    app.app.database,
    {
      id: check!.id,
      text: "Still waiting for a substantive answer",
      evidence: check!.sourceIds[0]!,
      quote: "Please give",
      at: null,
      afterDays: null,
    },
    {
      id: check!.id,
      workspaceId: run.workspaceId,
      ownerId: run.owner.id,
      threadId: null,
      checkAt: START + 3 * DAY,
      now: START + DAY,
    }
  );
  const [revised] = intake.openChecks(run.workspaceId, run.owner);
  expect(revised!.checkAt).toBe(check!.checkAt);
  expect(revised!.deadlineAt).toBe(check!.deadlineAt);
  expect(revised!.sourceIds).toEqual(check!.sourceIds);
});

test("an empty quiet time assessment completes its review without a model call each minute", async () => {
  const run = await setup({ quietTime: true });
  await intake.tick(START + 1000);
  const [check] = intake.openChecks(run.workspaceId, run.owner);
  await intake.tick(check!.checkAt + 1000);
  const calls = run.assessments();
  await intake.tick(check!.checkAt + 61_000);
  expect(run.assessments()).toBe(calls);
  expect(
    intake.openChecks(run.workspaceId, run.owner)[0]!.reviewAt
  ).toBeGreaterThan(check!.checkAt + DAY);
  expect(run.deliveries).toHaveLength(0);
});

test("an agent draft is retrieval context and does not become a new source event", async () => {
  const run = await setup({
    dialogue: [
      {
        id: "draft",
        text: "I will send the offer tomorrow",
        author: "Golem",
        authorId: "golem",
        agent: true,
        failed: false,
        files: [],
        streaming: false,
        work: null,
        time: START,
      },
    ],
  });
  const channel = app.app.workspaces.createChannel(
    run.workspaceId,
    run.owner,
    "private-drafts",
    true
  );
  await app.app.threads.startAgentThread(
    run.workspaceId,
    channel.id,
    "Automatic draft"
  );
  await intake.tick(START + 1000);
  expect(
    app.app.database
      .query(
        "SELECT count(*) n FROM intake_item WHERE credential_id LIKE 'thread:%'"
      )
      .get()
  ).toMatchObject({ n: 0 });
});

test("retrieval retains a queued subject after newer unrelated subjects replace recent context", async () => {
  const run = await setup({ initialNotice: "brief", target: "private" });
  await intake.tick(START);
  const subject = run.target!;
  app.app.database.query("UPDATE intake_check SET state='resolved'").run();
  for (let i = 0; i < 13; i += 1) {
    const thread = await app.app.threads.startAgentThread(
      run.workspaceId,
      subject.channelId,
      `Unrelated subject ${i}`
    );
    app.app.database
      .query("INSERT INTO intake_context VALUES(?,?,?,?,?,?)")
      .run(
        run.workspaceId,
        run.owner.id,
        thread.id,
        "Unrelated",
        "[]",
        START + i + 1
      );
  }
  run.items([
    {
      ...item(
        "reply",
        "Here is the substantive response. Repairs start Monday.",
        false,
        START + DAY
      ),
      chat: "conversation-request",
    },
  ]);
  await intake.tick(START + DAY);
  expect(run.snapshots.at(-1)!.threads.map((thread) => thread.id)).toContain(
    subject.id
  );
});

test("retrieval keeps search rank instead of the workspace's thread order", async () => {
  const run = await setup();
  const channel = app.app.workspaces.createChannel(
    run.workspaceId,
    run.owner,
    "private-context",
    true
  );
  for (let i = 0; i < 3; i += 1) {
    await app.app.threads.startAgentThread(
      run.workspaceId,
      channel.id,
      `Matter ${i}`
    );
  }
  const ranked = app.app.workspaces
    .threadsIn(run.workspaceId, run.owner.id)
    .slice()
    .reverse();
  const recall = new IntakeRecall(
    app.app.database,
    app.app.workspaces,
    {
      watched: () => [],
      watch: async () => [],
      attachment: async () => new Uint8Array(),
    },
    {
      messages: async () => ({ messages: [], running: false, approvals: [] }),
    },
    {
      search: async () => ({
        semantic: false,
        results: ranked.map((thread) => ({
          threadId: thread.id,
          title: thread.title,
          uri: `thread:${thread.id}`,
          kind: "thread",
          channelId: thread.channelId,
          loc: null,
          modality: "text",
          score: 1,
          snippet: "",
          updatedAt: START,
        })),
      }),
    },
    intake.audit
  );
  const context = await recall.context(
    run.workspaceId,
    run.owner,
    [
      {
        id: "query",
        conversation: "query",
        text: "repair claim",
        source: "Mail",
        fromOwner: true,
        url: null,
        at: START,
      },
    ],
    []
  );
  expect(context.map((thread) => thread.id)).toEqual(
    ranked.map((thread) => thread.id)
  );
});

for (const target of ["private", "shared"] as const) {
  test(`a developer email is posted to the existing ${target} claim thread with its files, and notifies its owner once`, async () => {
    const run = await setup({ target, noticeReply: true, actualReview: true });
    await intake.tick(START + 1000);
    const count = app.app.workspaces.threadsIn(
      run.workspaceId,
      run.owner.id
    ).length;
    run.items([
      item(
        "reply",
        "Here is the substantive response. Repairs start Monday.",
        false,
        START + DAY,
        [
          {
            id: "appointment",
            name: "repair.ics",
            type: "text/calendar",
            size: 30,
          },
        ]
      ),
    ]);
    await intake.tick(START + DAY);
    expect(
      app.app.workspaces.threadsIn(run.workspaceId, run.owner.id)
    ).toHaveLength(count);
    expect(run.reviews.map((review) => review.threadId)).toEqual([
      run.target!.id,
    ]);
    const state = await app.app.threads.messages(run.target!);
    const prompt = state.messages.find((message) => message.observation)!;
    expect(prompt.text).toContain("The developer replied");
    expect(prompt.files).toHaveLength(2);
    expect(prompt.files.some((file) => file.name.endsWith("repair.ics"))).toBe(
      true
    );
    const { path } = await app.app.threads.file(
      run.workspaceId,
      run.owner,
      prompt.files[0]!.id
    );
    expect(await Bun.file(path).text()).toContain("Repairs start Monday");
    // The update is the newest message: no agent works on it.
    expect(state.messages.at(-1)).toMatchObject({ observation: true });
    await app.signIn("Bob", "bob@example.com");
    const { internalAdapter } = await app.app.auth.$context;
    const bob = (await internalAdapter.findUserByEmail("bob@example.com"))!
      .user;
    app.app.database
      .query(
        "INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,'member',?)"
      )
      .run("reader-bob", run.workspaceId, bob.id, Date.now());
    if (target === "shared") {
      expect(
        (await app.app.threads.file(run.workspaceId, bob, prompt.files[0]!.id))
          .path
      ).toBe(path);
    } else {
      await expect(
        app.app.threads.file(run.workspaceId, bob, prompt.files[0]!.id)
      ).rejects.toThrow();
    }
    expect(
      app.app.notifications.inbox(run.workspaceId, bob).notifications
    ).toHaveLength(0);
    expect(
      app.app.notifications.inbox(run.workspaceId, run.owner).notifications
    ).toEqual([expect.objectContaining({ threadId: run.target!.id })]);
    const calls = app.faux.state.callCount;
    await intake.tick(START + DAY + 16 * 60_000);
    expect(app.faux.state.callCount).toBe(calls);
    expect(
      app.app.notifications.inbox(run.workspaceId, run.owner).notifications
    ).toHaveLength(1);
    expect(
      app.app.notifications.inbox(run.workspaceId, run.owner).notifications
    ).toHaveLength(1);
    expect(
      (await app.app.threads.messages(run.target!)).messages.filter(
        (message) => message.observation
      )
    ).toHaveLength(1);
  });
}

test("judge batches preserve whole email bodies, outgoing direction, and attachment metadata", async () => {
  const run = await setup({ decide: () => [] });
  const first = `${"First body. ".repeat(1300)}A promise at the end.`;
  const second = `${"Second body. ".repeat(2300)}The final correction.`;
  run.items([
    {
      ...item("first", first, true, START),
      bulk: true,
      attachments: [
        {
          id: "ticket",
          name: "ticket.pdf",
          type: "application/pdf",
          size: 1200,
        },
      ],
    },
    item("second", second, false, START + 1),
  ]);
  await intake.tick(START + 1000);
  expect(run.snapshots).toHaveLength(2);
  const fresh = run.snapshots.flatMap((snapshot) =>
    snapshot.evidence.filter((e) => snapshot.newEvidenceIds.includes(e.id))
  );
  expect(fresh.map((e) => e.text)).toEqual([first, second]);
  expect(fresh[0]).toMatchObject({
    fromOwner: true,
    bulk: true,
    attachments: [{ name: "ticket.pdf", type: "application/pdf", size: 1200 }],
  });
});

test("a failed judge batch does not stop other conversations or retry on every minute tick", async () => {
  const run = await setup({
    decide: (input) => {
      if (
        input.newEvidenceIds.some(
          (id) => input.evidence.find((e) => e.id === id)?.text === "Bad source"
        )
      ) {
        throw new Error("Invalid result");
      }
      return [];
    },
  });
  run.items(
    Array.from({ length: 7 }, (_, i) =>
      item(String(i), i === 0 ? "Bad source" : "Other source", true, START + i)
    )
  );
  await intake.tick(START + 1000);
  expect(run.assessments()).toBe(2);
  expect(
    app.app.database
      .query("SELECT count(*) n FROM intake_item WHERE assessed_at IS NOT NULL")
      .get()
  ).toMatchObject({ n: 1 });
  await intake.tick(START + 2000);
  expect(run.assessments()).toBe(2);
});

test("a pinned review retains its subject even when search returns other threads", async () => {
  const run = await setup({ target: "private" });
  await intake.tick(START);
  const recall = new IntakeRecall(
    app.app.database,
    app.app.workspaces,
    {
      watched: () => [run.credential],
      watch: async () => [],
      attachment: async () => new Uint8Array(),
    },
    app.app.threads,
    {
      search: async () => {
        throw new Error(
          "Pinned reviews must not use search to choose another subject"
        );
      },
    },
    intake.audit
  );
  const context = await recall.context(
    run.workspaceId,
    run.owner,
    [],
    [],
    run.target!.id
  );
  expect(context.map((t) => t.id)).toEqual([run.target!.id]);
  await expect(
    recall.context(run.workspaceId, run.owner, [], [], "missing")
  ).rejects.toMatchObject({ status: 404 });
  expect(
    recall.relevantChecks(
      run.workspaceId,
      run.owner,
      [
        {
          id: "unrelated",
          conversation: "different",
          text: "Violet bicycle frame",
          source: "Mail",
          fromOwner: false,
          url: null,
          at: START,
        },
      ],
      []
    )
  ).toHaveLength(0);
});

test("bounded recall keeps the latest thread message before older summaries", async () => {
  const run = await setup({ target: "private", decide: () => [] });
  const recall = new IntakeRecall(
    app.app.database,
    app.app.workspaces,
    {
      watched: () => [],
      watch: async () => [],
      attachment: async () => new Uint8Array(),
    },
    {
      messages: async () => ({
        messages: Array.from({ length: 4 }, (_, i) => ({
          id: String(i + 1),
          text:
            i === 3
              ? "The claim has been resolved by phone."
              : "Old draft. ".repeat(100),
          author: "Alice",
          authorId: run.owner.id,
          agent: false,
          failed: false,
          files: [],
          streaming: false,
          work: null,
          time: START + i,
        })),
        running: false,
        approvals: [],
      }),
    },
    { search: async () => ({ results: [], semantic: false }) },
    intake.audit
  );
  app.app.database
    .query("INSERT INTO intake_context VALUES(?,?,?,?,?,?)")
    .run(
      run.workspaceId,
      run.owner.id,
      run.target!.id,
      "Old summary. ".repeat(200),
      "[]",
      START
    );
  const context = await recall.context(
    run.workspaceId,
    run.owner,
    [],
    [],
    run.target!.id
  );
  expect(context[0]!.context).toContain(
    "The claim has been resolved by phone."
  );
  expect(context[0]!.context.length).toBeLessThanOrEqual(2400);
});

test("source-read reassessment visits every check in a busy thread in bounded calls", async () => {
  const options: Parameters<typeof setup>[0] = { target: "private" };
  const run = await setup(options);
  await intake.tick(START);
  options.decide = resolvesOnlyRead;
  const original = intake.openChecks(run.workspaceId, run.owner)[0]!;
  for (let index = 0; index < 13; index += 1) {
    saveCheck(
      app.app.database,
      {
        id: null,
        text: `Unanswered question ${index}`,
        evidence: original.sourceIds[0]!,
        quote: "claim",
        at: null,
        afterDays: null,
      },
      {
        id: `question-${index}`,
        workspaceId: run.workspaceId,
        ownerId: run.owner.id,
        threadId: run.target!.id,
        checkAt: START + DAY,
        now: START,
      }
    );
  }
  const reply = item(
    "full-answer",
    "Here is the substantive response. Repairs start Monday.",
    false,
    START
  );
  intake.recordSourceRead(run.target!, run.owner.id, {
    credential: run.credential,
    tool: "google_mail_thread",
    result: {},
    items: [reply],
  });
  await intake.tick(START + 60_000);
  const judgments = run.snapshots.filter(
    (input) => input.trigger === "source_read"
  );
  expect(judgments.map((input) => input.checks.length)).toEqual([12, 2]);
  expect(intake.openChecks(run.workspaceId, run.owner)).toEqual([]);
  expect(run.reviews).toHaveLength(0);
});

test("rereading the same source reassesses a later revised check without duplicating the source", async () => {
  const options: Parameters<typeof setup>[0] = { target: "private" };
  const run = await setup(options);
  await intake.tick(START);
  options.decide = resolvesOnlyRead;
  const original = intake.openChecks(run.workspaceId, run.owner)[0]!;
  const reply = item(
    "same-answer",
    "Here is the substantive response. Repairs start Monday.",
    false,
    START
  );
  const read = {
    credential: run.credential,
    tool: "google_mail_thread",
    result: {},
    items: [reply],
  };
  intake.recordSourceRead(run.target!, run.owner.id, read);
  await intake.tick(START + 60_000);
  expect(intake.openChecks(run.workspaceId, run.owner)).toEqual([]);
  saveCheck(
    app.app.database,
    {
      id: null,
      text: "Check the remaining repair",
      evidence: original.sourceIds[0]!,
      quote: "claim",
      at: null,
      afterDays: null,
    },
    {
      id: "remaining",
      workspaceId: run.workspaceId,
      ownerId: run.owner.id,
      threadId: run.target!.id,
      checkAt: START + DAY,
      now: START + 90_000,
    }
  );
  options.decide = () => [];
  intake.recordSourceRead(run.target!, run.owner.id, read);
  expect(
    app.app.database
      .query(
        "SELECT count(*) n FROM intake_source_read WHERE assessed_at IS NULL"
      )
      .get()
  ).toEqual({ n: 1 });
  await intake.tick(START + 120_000);
  expect(
    run.snapshots.filter((input) => input.trigger === "source_read")
  ).toHaveLength(2);
  expect(
    app.app.database.query("SELECT count(*) n FROM intake_source_read").get()
  ).toEqual({ n: 1 });
  expect(
    app.app.database
      .query("SELECT count(*) n FROM intake_item WHERE source_id='same-answer'")
      .get()
  ).toEqual({ n: 1 });
});

function proposedSubject(
  input: AssessmentInput,
  title: string,
  attention: Assessment["attention"] = "brief"
): Assessment {
  return {
    threadId: null,
    startThread: true,
    ...newThreadPlace(input),
    title,
    summary: "A repair matter needs review",
    attention,
    notification: null,
    message: "Review the repair matter and propose next actions",
    evidence: input.newEvidenceIds.length
      ? input.newEvidenceIds
      : input.evidence.map((each) => each.id),
    checks: [],
    resolved: [],
  };
}

test("passive filing creates no subject thread even if the judge proposes one", async () => {
  const run = await setup({
    decide: (input) => [
      {
        ...proposedSubject(input, "Repair notes", "none"),
        channelId: null,
        newChannel: { name: "housing", summary: "Housing" },
      },
    ],
  });
  await intake.tick(START);
  expect(
    app.app.workspaces.threadsIn(run.workspaceId, run.owner.id)
  ).toHaveLength(0);
  expect(
    app.app.workspaces
      .channelsIn(run.workspaceId, run.owner.id)
      .some((channel) => channel.name === "housing")
  ).toBe(false);
  expect(
    app.app.database.query("SELECT count(*) n FROM intake_delivery").get()
  ).toEqual({ n: 0 });
  expect(intake.status(run.workspaceId, run.owner).evidence).toHaveLength(1);
});

test("a new morning subject stays a proposal until due, survives restart, and creates one destination", async () => {
  const run = await setup({
    decide: (input) => [
      {
        ...proposedSubject(input, "Flat repairs"),
        channelId: null,
        newChannel: { name: "housing", summary: "Housing matters" },
      },
    ],
  });
  await intake.tick(START);
  expect(subjectThreads(run)).toHaveLength(0);
  expect(
    app.app.workspaces
      .channelsIn(run.workspaceId, run.owner.id)
      .map((channel) => channel.name)
  ).toEqual(["general"]);
  expect(
    app.app.database
      .query("SELECT thread_id,subject FROM intake_delivery")
      .get()
  ).toMatchObject({ thread_id: null, subject: expect.any(String) });
  expect(
    app.app.database
      .query("SELECT count(*) n FROM intake_item WHERE archived_id IS NOT NULL")
      .get()
  ).toEqual({ n: 0 });
  await run.restart();
  const morning = Date.parse("2026-10-02T08:00:00+02:00");
  await intake.tick(morning);
  const threads = subjectThreads(run);
  expect(threads).toHaveLength(1);
  expect(run.posts.map((post) => post.threadId)).toEqual([
    threads[0]!.id,
    (await app.app.threads.orchestrator(run.workspaceId, run.owner)).id,
  ]);
  expect(
    app.app.workspaces
      .channelsIn(run.workspaceId, run.owner.id)
      .some(
        (channel) =>
          channel.name === "housing" && channel.ownerId === run.owner.id
      )
  ).toBe(true);
  expect(run.posts[0]!.files).toHaveLength(1);
  await intake.tick(morning + 60_000);
  expect(run.posts).toHaveLength(2);
  expect(subjectThreads(run)).toHaveLength(1);
});

test("an owner reply cancels a queued new subject without leaving a channel, thread, or files", async () => {
  const run = await setup({
    decide: (input) => {
      const handled = input.evidence.some(
        (each) => each.text === "I handled this."
      );
      if (handled) {
        return [
          {
            ...proposedSubject(input, "Flat repairs", "none"),
            startThread: false,
            channelId: null,
            summary: "",
            message: "",
          },
        ];
      }
      return [
        {
          ...proposedSubject(input, "Flat repairs"),
          channelId: null,
          newChannel: { name: "housing", summary: "Housing" },
        },
      ];
    },
  });
  await intake.tick(START);
  run.items([
    {
      ...item("handled", "I handled this.", true, START + 60_000),
      chat: "conversation-request",
    },
  ]);
  await intake.tick(Date.parse("2026-10-02T08:00:00+02:00"));
  expect(run.reviews).toHaveLength(0);
  expect(
    app.app.workspaces.threadsIn(run.workspaceId, run.owner.id)
  ).toHaveLength(0);
  expect(
    app.app.workspaces
      .channelsIn(run.workspaceId, run.owner.id)
      .map((channel) => channel.name)
  ).toEqual(["general"]);
  expect(
    app.app.database
      .query("SELECT count(*) n FROM intake_item WHERE archived_id IS NOT NULL")
      .get()
  ).toEqual({ n: 0 });
  expect(
    app.app.database.query("SELECT cancelled_at FROM intake_delivery").get()
  ).toMatchObject({ cancelled_at: expect.any(Number) });
});

test("the morning review reuses a differently titled thread created after queuing", async () => {
  const run = await setup({
    decide: (input) => [proposedSubject(input, "Developer claim")],
    plan: (input) => {
      const existing = input.threads.find(
        (thread) => thread.title === "Balcony repairs"
      )!;
      return {
        summary: "Morning",
        topics: [
          {
            updates: input.updates.map((update) => update.id),
            threadId: existing.id,
            title: existing.title,
            channelId: null,
            newChannel: null,
            message: "The developer answered about the balcony.",
            ask: null,
            due: null,
            line: "The developer answered",
          },
        ],
        dropped: [],
      };
    },
  });
  await intake.tick(START);
  const channel = app.app.workspaces.channelsIn(
    run.workspaceId,
    run.owner.id
  )[0]!;
  const existing = await app.app.threads.startAgentThread(
    run.workspaceId,
    channel.id,
    "Balcony repairs"
  );
  await intake.tick(Date.parse("2026-10-02T08:00:00+02:00"));
  expect(run.posts[0]!.threadId).toBe(existing.id);
  expect(subjectThreads(run)).toHaveLength(1);
});

test("two proposals for the same matter reuse the first destination and produce one thread review", async () => {
  const run = await setup({
    decide: (input) => {
      if (input.trigger === "destination") {
        const existing = input.threads.find(
          (thread) => thread.title === "Identity review"
        );
        return [
          {
            ...proposedSubject(input, "Identity review", "now"),
            threadId: existing?.id ?? null,
            startThread: !existing,
            ...(existing
              ? { channelId: null, newChannel: null }
              : newThreadPlace(input)),
          },
        ];
      }
      return input.newEvidenceIds.map((id, index) => ({
        ...proposedSubject(
          input,
          index === 0 ? "Identity review" : "Seller verification",
          "now"
        ),
        evidence: [id],
      }));
    },
  });
  run.items([
    item("identity", "Please supply an identity document.", false, START),
    item("verification", "Your seller verification is pending.", false, START),
  ]);
  await intake.tick(START);
  expect(
    run.snapshots.filter((input) => input.trigger === "destination")
  ).toHaveLength(2);
  expect(
    app.app.workspaces.threadsIn(run.workspaceId, run.owner.id)
  ).toHaveLength(1);
  expect(run.reviews).toHaveLength(1);
  expect(run.reviews[0]!.files).toHaveLength(2);
  expect(run.reviews[0]!.text).toContain("Review the repair matter");
});

test("a failure after thread creation resumes the saved proposal without another thread", async () => {
  const run = await setup({ initialNotice: "now", failAfterThreadStart: true });
  await intake.tick(START);
  expect(run.reviews).toHaveLength(0);
  const created = app.app.workspaces.threadsIn(run.workspaceId, run.owner.id);
  expect(created).toHaveLength(1);
  await run.restart();
  await intake.tick(START + 60_000);
  expect(
    app.app.workspaces
      .threadsIn(run.workspaceId, run.owner.id)
      .map((thread) => thread.id)
  ).toEqual([created[0]!.id]);
  expect(run.reviews.map((review) => review.threadId)).toEqual([
    created[0]!.id,
  ]);
});

test("two unrelated matters in one email keep separate queued subjects and destinations", async () => {
  const run = await setup({
    decide: (input) => {
      if (input.trigger === "destination") {
        return [proposedSubject(input, input.pendingSubject!.title, "now")];
      }
      return [
        proposedSubject(input, "Flat repair claim", "now"),
        proposedSubject(input, "Conference preparation", "now"),
      ];
    },
  });
  await intake.tick(START);
  expect(
    app.app.database.query("SELECT count(*) n FROM intake_delivery").get()
  ).toEqual({ n: 2 });
  expect(
    app.app.workspaces
      .threadsIn(run.workspaceId, run.owner.id)
      .map((thread) => thread.title)
      .toSorted((left, right) => left.localeCompare(right))
  ).toEqual(["Conference preparation", "Flat repair claim"]);
  expect(run.reviews).toHaveLength(2);
  expect(new Set(run.reviews.map((review) => review.threadId)).size).toBe(2);
});

test("Following keeps stops distinct from resolution, cancels work, and can undo or reopen", async () => {
  const run = await setup({ initialNotice: "brief" });
  await intake.tick(START + 1000);
  const [check] = intake.following.list(run.workspaceId, run.owner);
  expect(check!.state).toBe("open");
  const original = intake.following.detail(
    run.workspaceId,
    run.owner,
    check!.id
  );
  expect(original.evidence[0]!.text).toContain("30 days");
  expect(original.history.length).toBeGreaterThan(0);
  const stopped = await intake.following.change(
    run.workspaceId,
    run.owner,
    check!.id,
    {
      action: "stop",
      revision: check!.revision,
      quote: "Do not follow this repair claim",
    }
  );
  expect(stopped.check.state).toBe("stopped");
  expect(intake.openChecks(run.workspaceId, run.owner)).toHaveLength(0);
  expect(stopped.history[0]!.quote).toBe("Do not follow this repair claim");
  expect(stopped.history[0]!.previous?.state).toBe("open");
  expect(
    app.app.database
      .query(
        "SELECT count(*) AS n FROM intake_delivery WHERE delivered_at IS NULL AND cancelled_at IS NULL"
      )
      .get()
  ).toEqual({ n: 0 });
  expect(
    intake.following.corrections(run.workspaceId, run.owner)[0]
  ).toMatchObject({
    state: "stopped",
    quote: "Do not follow this repair claim",
  });
  await expect(
    intake.following.change(run.workspaceId, run.owner, check!.id, {
      action: "handled",
      revision: check!.revision,
      quote: "Old screen",
    })
  ).rejects.toMatchObject({ status: 409 });
  const restored = await intake.following.change(
    run.workspaceId,
    run.owner,
    check!.id,
    { action: "undo", revision: stopped.check.revision, quote: "Undo" }
  );
  expect(restored.check.state).toBe("open");
  expect(restored.check.checkAt).toBe(check!.checkAt);
  const handled = await intake.following.change(
    run.workspaceId,
    run.owner,
    check!.id,
    {
      action: "handled",
      revision: restored.check.revision,
      quote: "I handled it offline",
    }
  );
  expect(handled.check.state).toBe("resolved");
  const reopened = await intake.following.change(
    run.workspaceId,
    run.owner,
    check!.id,
    {
      action: "reopen",
      revision: handled.check.revision,
      quote: "Follow again",
    }
  );
  expect(reopened.check.state).toBe("open");
  expect(reopened.check.checkAt).toBe(check!.checkAt);
  expect(reopened.check.reviewAt).toBeGreaterThan(check!.reviewAt);
  const feedback = intake.audit.last(
    check!.id,
    "feedback",
    run.workspaceId,
    run.owner.id
  ) as { before: unknown; after: unknown };
  expect(feedback.before).toBeDefined();
  expect(feedback.after).toBeDefined();
  const otherToken = await app.signIn("Bob", "bob@example.com");
  const other = (await (
    await app.call("/api/v1/me", { token: otherToken })
  ).json()) as { user: typeof run.owner };
  app.app.database
    .query(
      "INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,'member',?)"
    )
    .run("following-bob", run.workspaceId, other.user.id, Date.now());
  expect(intake.following.list(run.workspaceId, other.user)).toEqual([]);
  expect(() =>
    intake.following.detail(run.workspaceId, other.user, check!.id)
  ).toThrow();
});

test("a free-text correction changes the remaining matter and preserves its stated date and evidence", async () => {
  const run = await setup({
    correction: (text) => {
      const input = JSON.parse(text) as {
        check: { text: string };
        deadlineAt: string;
        correction: string;
      };
      expect(input.correction).toBe(
        "The warranty question is answered. Keep the repair schedule open."
      );
      return JSON.stringify({
        text: "Await the repair schedule",
        state: "open",
        deadlineAt: input.deadlineAt,
      });
    },
  });
  await intake.tick(START + 1000);
  const [check] = intake.following.list(run.workspaceId, run.owner);
  const corrected = await intake.following.change(
    run.workspaceId,
    run.owner,
    check!.id,
    {
      action: "correct",
      revision: check!.revision,
      quote:
        "The warranty question is answered. Keep the repair schedule open.",
    }
  );
  expect(corrected.check.text).toBe("Await the repair schedule");
  expect(corrected.check.checkAt).toBe(check!.checkAt);
  expect(corrected.check.reviewAt).toBe(check!.reviewAt);
  expect(corrected.check.sourceIds).toEqual(check!.sourceIds);
  expect(corrected.history[0]!.previous?.text).toBe(check!.text);
  expect(intake.openChecks(run.workspaceId, run.owner)[0]!.text).toBe(
    "Await the repair schedule"
  );
});

test("an invalid model correction leaves the check unchanged", async () => {
  const run = await setup({
    correction: () =>
      JSON.stringify({ text: "Change", state: "open", deadlineAt: "nonsense" }),
  });
  await intake.tick(START + 1000);
  const [check] = intake.following.list(run.workspaceId, run.owner);
  await expect(
    intake.following.change(run.workspaceId, run.owner, check!.id, {
      action: "correct",
      revision: check!.revision,
      quote: "Wait until next week",
    })
  ).rejects.toMatchObject({ status: 502 });
  expect(
    intake.following.detail(run.workspaceId, run.owner, check!.id).check
  ).toEqual(check!);
});

test("the person's answered turn marks the update that it took as delivered", async () => {
  app = await startTestApp();
  const token = await app.signIn("Alice", "alice@example.com");
  const { user } = (await (await app.call("/api/v1/me", { token })).json()) as {
    user: { id: string; name: string; email: string };
  };
  const owner = { id: user.id, name: user.name, email: user.email };
  const home =
    app.app.workspaces.list(owner)[0] ??
    (await app.app.workspaces.create(owner, "Home"));
  const [general] = app.app.workspaces.channels(home.id, owner);
  app.faux.setResponses(
    Array.from({ length: 40 }, () => fauxAssistantMessage("Ok."))
  );
  const { id: threadId } = await app.app.threads.create(
    home.id,
    owner,
    general!.id,
    "The balcony claim"
  );
  const thread = app.app.workspaces.thread(threadId, owner);
  const settled = () =>
    until(
      () => app.app.threads.messages(thread),
      (state) => !state.running && state.messages.at(-1)?.agent === true
    );
  await settled();
  const now = Date.now();
  app.app.database
    .query(
      "INSERT INTO credential (id, workspace_id, integration, owner_id, label, shared, secret, created_at, watched) VALUES ('mail', ?, 'google', ?, 'alice@example.com', 0, x'00', ?, 1)"
    )
    .run(home.id, owner.id, now);
  app.app.database
    .query(
      "INSERT INTO intake_item(id,credential_id,workspace_id,owner_id,source_id,version,payload,at) VALUES('reply','mail',?,?,'reply','1',?,?)"
    )
    .run(
      home.id,
      owner.id,
      JSON.stringify(item("reply", "The developer answered.", false, now)),
      now
    );
  app.app.database
    .query(
      "INSERT INTO intake_delivery(id,workspace_id,owner_id,thread_id,body,attention,check_ids,evidence_ids,created_at) VALUES('update',?,?,?,'The developer answered.','brief','[]','[\"reply\"]',?)"
    )
    .run(home.id, owner.id, threadId, now);
  const delivered = () =>
    (
      app.app.database
        .query("SELECT delivered_at FROM intake_delivery WHERE id='update'")
        .get() as { delivered_at: number | null }
    ).delivered_at;
  await app.app.threads.send(threadId, owner, "What did the developer say?");
  await until(
    async () => delivered(),
    (at) => at !== null
  );
  expect(delivered()).toBeNumber();
});

test("a message that a thread's agent reads before intake polls it still gets the normal assessment", async () => {
  const run = await setup({ target: "private" });
  await intake.tick(START);
  const invoice = item(
    "invoice",
    "Please send the signed invoice by Friday.",
    false,
    START + 1000
  );
  intake.recordSourceRead(run.target!, run.owner.id, {
    credential: run.credential,
    tool: "google_mail_thread",
    result: {},
    items: [invoice],
  });
  await intake.tick(START + 60_000);
  expect(
    run.snapshots.some(
      (input) =>
        input.trigger === "evidence" &&
        input.evidence.some(
          (each) =>
            input.newEvidenceIds.includes(each.id) && each.text === invoice.text
        )
    )
  ).toBe(true);
});

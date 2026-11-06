import { expect, spyOn, test } from "bun:test";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, until } from "../../test/harness.ts";
import type { ThreadSummary } from "../workspaces/workspaces.ts";

const DAY_MS = 24 * 60 * 60_000;

function systemOf(context: Context): string {
  return [
    context.systemPrompt ?? "",
    ...context.messages
      .filter((message) => (message.role as string) === "system")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("")
      ),
  ].join("\n");
}

test("daily settling reviews only inactive channel threads, keeps unresolved work open, and rejects stale decisions", async () => {
  const golem = await startTestApp();
  const reviews: string[] = [];
  let changedThread: ThreadSummary;
  let release: (() => void) | undefined;
  try {
    await golem.signIn("Alice", "alice@example.com");
    await golem.signIn("Bob", "bob@example.com");
    const { internalAdapter } = await golem.app.auth.$context;
    const alice = (await internalAdapter.findUserByEmail("alice@example.com"))!
      .user;
    const bob = (await internalAdapter.findUserByEmail("bob@example.com"))!
      .user;
    const home = await golem.app.workspaces.create(alice, "Daily settling");
    await golem.app.workspaces.addMember(home.id, alice, bob.email);
    const general = golem.app.workspaces.channels(home.id, alice)[0]!;

    const agent = async (context: Context, options?: SimpleStreamOptions) => {
      const system = systemOf(context);
      const last = context.messages.at(-1)!;
      const text =
        typeof last.content === "string"
          ? last.content
          : last.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("");
      if (system.includes("You review an inactive thread")) {
        reviews.push(text);
        if (
          text.includes("Waiting for a reply") ||
          text.includes("Unclear outcome")
        ) {
          return fauxAssistantMessage("KEEP_OPEN");
        }
        if (text.includes("Review unavailable")) {
          throw new Error("Model unavailable");
        }
        if (text.includes("Invalid review")) {
          return fauxAssistantMessage("Maybe SETTLE");
        }
        if (text.includes("Changed during review")) {
          await golem.app.threads.send(
            changedThread.id,
            alice,
            "A new unresolved question"
          );
        }
        return fauxAssistantMessage("SETTLE");
      }
      if (system.includes("You keep the brief")) {
        return fauxAssistantMessage(
          "<summary>General.</summary><brief>Family discussions.</brief>"
        );
      }
      if (system.includes("You are the learning loop")) {
        return fauxAssistantMessage("{}");
      }
      if (last.role === "user" && text.endsWith("Still running")) {
        return new Promise<ReturnType<typeof fauxAssistantMessage>>(
          (resolve, reject) => {
            release = () => resolve(fauxAssistantMessage("Done."));
            options?.signal?.addEventListener("abort", () =>
              reject(new Error("Stopped"))
            );
          }
        );
      }
      return fauxAssistantMessage("Done.");
    };
    golem.faux.setResponses(Array.from({ length: 300 }, () => agent));

    const create = async (text: string) => {
      const thread = await golem.app.threads.create(
        home.id,
        alice,
        general.id,
        text
      );
      await until(
        () =>
          golem.app.threads.messages(
            golem.app.workspaces.thread(thread.id, alice)
          ),
        (state) => !state.running && state.messages.length === 2
      );
      return thread;
    };
    const recipe = await create("Recipe completed");
    const waiting = await create("Waiting for a reply");
    const uncertain = await create("Unclear outcome");
    const unavailable = await create("Review unavailable");
    const invalid = await create("Invalid review");
    changedThread = await create("Changed during review");
    const recent = await create("Recent discussion");
    const boundary = await create("Exactly seven days");
    const already = await create("Already settled");
    golem.app.workspaces.setThreadSettled(home.id, already.id, alice, true);
    const own = await golem.app.threads.orchestrator(home.id, alice);
    const running = await golem.app.threads.create(
      home.id,
      alice,
      general.id,
      "Still running"
    );
    await until(async () => release, Boolean);

    const now = Date.now() + 8 * DAY_MS;
    golem.app.database
      .query("UPDATE thread SET updated_at = ? WHERE id = ?")
      .run(now - DAY_MS, recent.id);
    golem.app.database
      .query("UPDATE thread SET updated_at = ? WHERE id = ?")
      .run(now - 7 * DAY_MS, boundary.id);
    const states: (number | null)[] = [];
    const stopThread = await golem.app.threads.watch(
      golem.app.workspaces.thread(recipe.id, alice),
      () => {
        states.push(golem.app.workspaces.thread(recipe.id, alice).settledAt);
      }
    );
    const workspaceStates: (number | null)[] = [];
    const stopWorkspace = await golem.app.threads.watchWorking(
      home.id,
      alice,
      () => {
        workspaceStates.push(
          golem.app.workspaces.thread(recipe.id, alice).settledAt
        );
      }
    );
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const first = golem.app.threads.settleInactive(home.id, now);
      expect(golem.app.threads.settleInactive(home.id, now)).toBe(first);
      await first;
      expect(errors.mock.calls).toHaveLength(2);
    } finally {
      errors.mockRestore();
      await stopThread();
      await stopWorkspace();
    }
    expect(golem.app.workspaces.thread(recipe.id, alice).settledAt).toEqual(
      expect.any(Number)
    );
    for (const thread of [
      waiting,
      uncertain,
      unavailable,
      invalid,
      changedThread,
      recent,
      boundary,
      running,
      own,
    ]) {
      expect(
        golem.app.workspaces.thread(thread.id, alice).settledAt
      ).toBeNull();
    }
    expect(states.at(-1)).toEqual(expect.any(Number));
    expect(workspaceStates.at(-1)).toEqual(expect.any(Number));
    expect(reviews).toHaveLength(6);
    const checked = reviews.length;
    await golem.app.threads.settleInactive(home.id, now + DAY_MS - 1);
    expect(reviews).toHaveLength(checked);

    release!();
    release = undefined;
    await until(
      () =>
        golem.app.threads.messages(
          golem.app.workspaces.thread(running.id, alice)
        ),
      (state) => !state.running
    );
    await golem.app.indexer.scan(home.id);
    const recalled = await golem.app.indexer.search(
      home.id,
      "Recipe completed",
      20,
      alice.id
    );
    expect(
      recalled.results.some((result) => result.threadId === recipe.id)
    ).toBe(true);
  } finally {
    release?.();
    await golem.close();
  }
});

test("private threads settle without sending workspace events to another member", async () => {
  const golem = await startTestApp();
  try {
    await golem.signIn("Alice", "alice@example.com");
    await golem.signIn("Bob", "bob@example.com");
    const { internalAdapter } = await golem.app.auth.$context;
    const alice = (await internalAdapter.findUserByEmail("alice@example.com"))!
      .user;
    const bob = (await internalAdapter.findUserByEmail("bob@example.com"))!
      .user;
    const home = await golem.app.workspaces.create(alice, "Private settling");
    await golem.app.workspaces.addMember(home.id, alice, bob.email);
    const privateChannel = golem.app.workspaces.createChannel(
      home.id,
      alice,
      "private",
      true
    );
    golem.faux.setResponses(
      Array.from(
        { length: 100 },
        () => (context: Context) =>
          fauxAssistantMessage(
            systemOf(context).includes("You review an inactive thread")
              ? "SETTLE"
              : "Done."
          )
      )
    );
    const recipe = await golem.app.threads.create(
      home.id,
      alice,
      privateChannel.id,
      "Recipe completed"
    );
    await until(
      () =>
        golem.app.threads.messages(
          golem.app.workspaces.thread(recipe.id, alice)
        ),
      (state) => !state.running && state.messages.length === 2
    );
    let alices = 0;
    let bobs = 0;
    const stopAlice = await golem.app.threads.watchWorking(
      home.id,
      alice,
      () => {
        alices += 1;
      }
    );
    const stopBob = await golem.app.threads.watchWorking(home.id, bob, () => {
      bobs += 1;
    });
    try {
      await golem.app.threads.settleInactive(home.id, Date.now() + 8 * DAY_MS);
      expect(golem.app.workspaces.thread(recipe.id, alice).settledAt).toEqual(
        expect.any(Number)
      );
      expect(alices).toBe(2);
      expect(bobs).toBe(1);
      expect(() => golem.app.workspaces.thread(recipe.id, bob)).toThrow(
        "Not found"
      );
    } finally {
      await stopAlice();
      await stopBob();
    }
  } finally {
    await golem.close();
  }
});

import { expect, test } from "bun:test";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, until } from "../../test/harness.ts";

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

test("daily settling settles topic chats quiet for more than 14 days, without a model, and new activity opens them again", async () => {
  const golem = await startTestApp();
  let release: (() => void) | undefined;
  const reviews: string[] = [];
  try {
    await golem.signIn("Alice", "alice@example.com");
    const { internalAdapter } = await golem.app.auth.$context;
    const alice = (await internalAdapter.findUserByEmail("alice@example.com"))!
      .user;
    const home = await golem.app.workspaces.create(alice, "Daily settling");
    const general = golem.app.workspaces.topics(home.id, alice)[0]!;
    const agent = async (context: Context, options?: SimpleStreamOptions) => {
      const last = context.messages.at(-1)!;
      const text =
        typeof last.content === "string"
          ? last.content
          : last.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("");
      if (systemOf(context).includes("inactive chat")) {
        reviews.push(text);
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
      const chat = await golem.app.chats.create(
        home.id,
        alice,
        general.id,
        text
      );
      await until(
        () =>
          golem.app.chats.messages(golem.app.workspaces.chat(chat.id, alice)),
        (state) => !state.running && state.messages.length === 2
      );
      return chat;
    };
    const quiet = await create("Recipe completed");
    const recent = await create("Recent discussion");
    const boundary = await create("Exactly fourteen days");
    const own = await golem.app.chats.orchestrator(home.id, alice);
    const running = await golem.app.chats.create(
      home.id,
      alice,
      general.id,
      "Still running"
    );
    await until(async () => release, Boolean);

    const now = Date.now() + 15 * DAY_MS;
    golem.app.database
      .query("UPDATE chat SET updated_at = ? WHERE id = ?")
      .run(now - DAY_MS, recent.id);
    golem.app.database
      .query("UPDATE chat SET updated_at = ? WHERE id = ?")
      .run(now - 14 * DAY_MS, boundary.id);
    const states: (number | null)[] = [];
    const stopChat = await golem.app.chats.watch(
      golem.app.workspaces.chat(quiet.id, alice),
      () => {
        states.push(golem.app.workspaces.chat(quiet.id, alice).settledAt);
      }
    );
    try {
      const first = golem.app.chats.settleInactive(home.id, now);
      expect(golem.app.chats.settleInactive(home.id, now)).toBe(first);
      await first;
    } finally {
      await stopChat();
    }
    expect(golem.app.workspaces.chat(quiet.id, alice).settledAt).toEqual(
      expect.any(Number)
    );
    expect(states.at(-1)).toEqual(expect.any(Number));
    for (const chat of [recent, boundary, running, own]) {
      expect(golem.app.workspaces.chat(chat.id, alice).settledAt).toBeNull();
    }
    expect(reviews).toEqual([]);

    // One check a day.
    golem.app.database
      .query("UPDATE chat SET updated_at = ? WHERE id = ?")
      .run(now - 20 * DAY_MS, recent.id);
    await golem.app.chats.settleInactive(home.id, now + DAY_MS - 1);
    expect(golem.app.workspaces.chat(recent.id, alice).settledAt).toBeNull();

    // A new message, such as a routine's answer, opens the settled chat again.
    await golem.app.chats.send(quiet.id, alice, "One more question");
    expect(golem.app.workspaces.chat(quiet.id, alice).settledAt).toBeNull();
  } finally {
    release?.();
    await golem.close();
  }
});

test("private chats settle without sending workspace events to another member", async () => {
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
    const privateTopic = golem.app.workspaces.createTopic(
      home.id,
      alice,
      "private",
      true
    );
    golem.faux.setResponses(
      Array.from({ length: 100 }, () => () => fauxAssistantMessage("Done."))
    );
    const recipe = await golem.app.chats.create(
      home.id,
      alice,
      privateTopic.id,
      "Recipe completed"
    );
    await until(
      () =>
        golem.app.chats.messages(golem.app.workspaces.chat(recipe.id, alice)),
      (state) => !state.running && state.messages.length === 2
    );
    let alices = 0;
    let bobs = 0;
    const stopAlice = await golem.app.chats.watchWorking(home.id, alice, () => {
      alices += 1;
    });
    const stopBob = await golem.app.chats.watchWorking(home.id, bob, () => {
      bobs += 1;
    });
    try {
      await golem.app.chats.settleInactive(home.id, Date.now() + 15 * DAY_MS);
      expect(golem.app.workspaces.chat(recipe.id, alice).settledAt).toEqual(
        expect.any(Number)
      );
      expect(alices).toBe(2);
      expect(bobs).toBe(1);
      expect(() => golem.app.workspaces.chat(recipe.id, bob)).toThrow(
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

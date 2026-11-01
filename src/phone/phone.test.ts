import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { User } from "../platform/auth.ts";
import { Phone, type PhoneCall } from "./phone.ts";

const alice: User = { id: "alice", name: "Alice", email: "alice@example.com" };

function setup(requester: User | null = alice) {
  const phone = new Phone({ requester: async () => requester });
  const run = (name: string, args: Record<string, unknown>) =>
    phone
      .tools("home")
      .find((tool) => tool.name === name)!
      .execute(
        args as never,
        { taskId: "task-1", conversationId: 1 } as never,
        BACKGROUND_CONTEXT
      );
  return { phone, run };
}

test("a phone tool runs on the open app of the turn's person and returns its answer", async () => {
  const { phone, run } = setup();
  const calls: PhoneCall[] = [];
  phone.connect(alice.id, (call) => calls.push(call));
  const result = run("phone_timer_start", { label: "Pasta", seconds: 600 });
  await Promise.resolve();
  expect(calls).toMatchObject([
    {
      workspaceId: "home",
      name: "timer_start",
      arguments: { label: "Pasta", seconds: 600 },
    },
  ]);
  expect(() =>
    phone.answer("bob", calls[0]!.id, { text: "no", images: [] })
  ).toThrow("There is no such call");
  phone.answer(alice.id, calls[0]!.id, {
    text: "Timer set",
    images: [
      new File([new Uint8Array([1, 2])], "a.jpg", { type: "image/jpeg" }),
    ],
  });
  expect((await result).output).toEqual([
    { type: "text", text: "Timer set" },
    { type: "image", data: "AQI=", mimeType: "image/jpeg" },
  ]);
});

test("a call goes to the newest stream and fails when it closes, or when no phone is open", async () => {
  const { phone, run } = setup();
  await expect(run("phone_device", {})).rejects.toThrow("not connected");
  const older: PhoneCall[] = [];
  const newer: PhoneCall[] = [];
  phone.connect(alice.id, (call) => older.push(call));
  const close = phone.connect(alice.id, (call) => newer.push(call));
  const result = run("phone_location", {});
  await Promise.resolve();
  expect([older.length, newer.length]).toEqual([0, 1]);
  close();
  await expect(result).rejects.toThrow("closed before it answered");
  const failed = run("phone_photo", { id: "x" });
  await Promise.resolve();
  phone.answer(alice.id, older[0]!.id, { error: "No such photo", images: [] });
  await expect(failed).rejects.toThrow("No such photo");
});

test("phone tools refuse a turn that no person asked for", async () => {
  const { run } = setup(null);
  await expect(run("phone_alarms", {})).rejects.toThrow("person who asked");
});

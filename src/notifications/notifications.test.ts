import { expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import type { User } from "../platform/auth.ts";
import { migrate, openDatabase } from "../platform/database.ts";
import { apnsOutcome, apnsPayload, providerToken } from "./apns.ts";
import {
  Notifications,
  type NotificationWorkspaces,
  type PushDevice,
  type PushMessage,
  plainText,
} from "./notifications.ts";

const alice: User = { id: "alice", name: "Alice", email: "alice@example.com" };
const eve: User = { id: "eve", name: "Eve", email: "eve@example.com" };
const TOKEN = "ab".repeat(32);
const answer = {
  workspaceId: "home",
  userId: alice.id,
  channelId: "general",
  threadId: "flights",
  title: "Flights",
  text: "## Found\n- **Prague → Rome**: 89 EUR, see [the offer](https://example.com) ![chart](file:1)",
};

function setup(
  answerPush: (device: PushDevice) => "sent" | "gone" = () => "sent"
) {
  const database = openDatabase(":memory:");
  migrate(database);
  const workspaces = {
    list: (user: User) =>
      user.id === alice.id ? [{ id: "home", name: "Home", role: "owner" }] : [],
    requireMember(workspaceId: string, user: User) {
      if (workspaceId !== "home" || user.id !== alice.id) {
        throw new Error("Not found");
      }
      return { id: "home", name: "Home", role: "owner" };
    },
  } as NotificationWorkspaces;
  const pushes: { device: PushDevice; message: PushMessage }[] = [];
  const notifications = new Notifications(
    database,
    workspaces,
    async (device, message) => {
      pushes.push({ device, message });
      return answerPush(device);
    }
  );
  return { database, notifications, pushes };
}

test("a notification goes to the inbox and to the person's devices as a push", async () => {
  const { notifications, pushes } = setup();
  notifications.addDevice(alice, TOKEN, "sandbox");
  const notification = notifications.notify(answer);
  expect(notification.text).toBe("Found Prague → Rome: 89 EUR, see the offer");
  await Bun.sleep(0);
  expect(pushes).toEqual([
    {
      device: expect.objectContaining({ token: TOKEN, environment: "sandbox" }),
      message: { notification, body: notification.text, badge: 1 },
    },
  ]);
  expect(notifications.inbox("home", alice)).toEqual({
    notifications: [notification],
    unread: 1,
    badge: 1,
  });
  expect(() => notifications.inbox("home", eve)).toThrow("Not found");
});

test("a person who has the thread open gets no push, and opening a thread reads its notifications", async () => {
  const { notifications, pushes } = setup();
  notifications.addDevice(alice, TOKEN, "production");
  notifications.notify(answer);
  const unwatch = notifications.watch(alice, "flights");
  expect(notifications.inbox("home", alice).unread).toBe(0);
  const seen = notifications.notify(answer);
  expect(seen.readAt).toBe(seen.createdAt);
  unwatch();
  unwatch();
  notifications.notify(answer);
  await Bun.sleep(0);
  expect(pushes).toHaveLength(2);
  expect(notifications.inbox("home", alice).unread).toBe(1);
});

test("people read one notification or all, only their own", () => {
  const { notifications } = setup();
  const first = notifications.notify(answer);
  notifications.notify({
    ...answer,
    threadId: null,
    text: "Look at the channel",
  });
  expect(notifications.read("home", alice, first.id).unread).toBe(1);
  expect(() => notifications.read("home", alice, "missing")).toThrow(
    "Not found"
  );
  expect(() => notifications.read("home", eve, null)).toThrow("Not found");
  expect(notifications.read("home", alice, null)).toMatchObject({
    unread: 0,
    badge: 0,
  });
});

test("a device takes the pushes of the last person who signed in on it, until it is gone", async () => {
  const { database, notifications, pushes } = setup(() => "gone");
  expect(() => notifications.addDevice(alice, "not hex", "sandbox")).toThrow(
    "Send the device token in hex"
  );
  expect(() => notifications.addDevice(alice, TOKEN, "staging")).toThrow(
    "Environment must be sandbox or production"
  );
  notifications.addDevice(eve, TOKEN, "sandbox");
  notifications.addDevice(alice, TOKEN, "sandbox");
  notifications.addDevice(alice, TOKEN, "sandbox");
  const live = () =>
    database
      .query(
        "SELECT user_id AS userId FROM push_device WHERE deleted_at IS NULL"
      )
      .all();
  expect(live()).toEqual([{ userId: alice.id }]);
  notifications.notify(answer);
  await Bun.sleep(0);
  expect(pushes).toHaveLength(1);
  expect(live()).toEqual([]);
  notifications.addDevice(alice, TOKEN, "sandbox");
  notifications.removeDevice(alice, TOKEN);
  expect(live()).toEqual([]);
});

test("plain text keeps what a person reads of Markdown", () => {
  expect(plainText("# Title\n\n1. one\n2. `two`\n> quoted <b>bold</b>")).toBe(
    "Title one two quoted bold"
  );
  expect(plainText("See [Rome](thread:abc) | 3 |")).toBe("See Rome 3");
});

test("APNs gets a provider token signed with the key, and a push that opens the thread", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const token = providerToken(
    { keyId: "KEY", teamId: "TEAM", privateKey: pem },
    Date.UTC(2026, 9, 26)
  );
  const [header, claims, signature] = token.split(".") as [
    string,
    string,
    string,
  ];
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
    alg: "ES256",
    kid: "KEY",
  });
  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
    iss: "TEAM",
    iat: Date.UTC(2026, 9, 26) / 1000,
  });
  expect(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url")
    )
  ).toBe(true);
  const notification = {
    ...answer,
    id: "n1",
    text: "Found",
    createdAt: 0,
    readAt: null,
  };
  expect(apnsPayload({ notification, body: "Found", badge: 2 })).toEqual({
    aps: {
      alert: { title: "Flights", body: "Found" },
      badge: 2,
      sound: "default",
      "thread-id": "flights",
    },
    notificationId: "n1",
    workspaceId: "home",
    channelId: "general",
    threadId: "flights",
  });
});

test("an APNs answer whose body is not JSON is an error and not a crash", () => {
  expect(apnsOutcome(200, "")).toBe("sent");
  expect(apnsOutcome(502, "<html>")).toBeInstanceOf(Error);
  expect(apnsOutcome(500, "null")).toBeInstanceOf(Error);
  expect(apnsOutcome(410, "")).toBe("gone");
  expect(apnsOutcome(400, '{"reason":"BadDeviceToken"}')).toBe("gone");
  expect(
    (apnsOutcome(429, '{"reason":"TooManyRequests"}') as Error).message
  ).toBe("APNs answered 429: TooManyRequests");
});

import { sign } from "node:crypto";
import { connect } from "node:http2";
import type { Push, PushMessage } from "./notifications.ts";

export interface ApnsKey {
  readonly keyId: string;
  readonly teamId: string;
  /** The iOS app's bundle id. */
  readonly topic: string;
  /** The `.p8` key in PEM. */
  readonly privateKey: string;
}

const HOSTS = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
} as const;
/** APNs takes a provider token for an hour and refuses a new one sooner than 20 minutes after the last. */
const TOKEN_AGE = 50 * 60_000;
/** What APNs answers for a device that takes no more pushes of this app. */
const GONE = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

/**
 * Sends pushes through the Apple Push Notification service. APNs speaks only HTTP/2, which Bun's `fetch` does not, so
 * this uses `node:http2`.
 */
export function apnsPush(key: ApnsKey): Push {
  let token = { value: "", at: 0 };
  return (device, message) => {
    if (Date.now() - token.at > TOKEN_AGE) {
      token = { value: providerToken(key), at: Date.now() };
    }
    // A family sends few pushes, so each gets its own connection and none needs to be kept alive.
    const session = connect(HOSTS[device.environment]);
    return new Promise<"sent" | "gone">((resolve, reject) => {
      session.on("error", reject);
      const stream = session.request({
        ":method": "POST",
        ":path": `/3/device/${device.token}`,
        authorization: `bearer ${token.value}`,
        "apns-topic": key.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
      });
      let status = 0;
      let body = "";
      stream.setEncoding("utf8");
      stream.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("error", reject);
      stream.on("end", () => {
        if (status === 200) {
          return resolve("sent");
        }
        const { reason } = JSON.parse(body || "{}") as { reason?: string };
        if (status === 410 || GONE.has(reason ?? "")) {
          return resolve("gone");
        }
        reject(new Error(`APNs answered ${status}: ${reason ?? body}`));
      });
      stream.end(JSON.stringify(apnsPayload(message)));
    }).finally(() => session.close());
  };
}

/** The push: the alert, the app icon's badge, and where a tap goes. */
export function apnsPayload({ notification, body, badge }: PushMessage) {
  return {
    aps: {
      alert: { title: notification.title, body },
      badge,
      sound: "default",
      "thread-id": notification.threadId ?? notification.channelId,
    },
    notificationId: notification.id,
    workspaceId: notification.workspaceId,
    channelId: notification.channelId,
    threadId: notification.threadId,
  };
}

/** The ES256 JSON Web Token that APNs takes as the provider's bearer token. */
export function providerToken(
  key: Pick<ApnsKey, "keyId" | "teamId" | "privateKey">,
  now = Date.now()
): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: key.keyId }));
  const claims = base64url(
    JSON.stringify({ iss: key.teamId, iat: Math.floor(now / 1000) })
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${base64url(signature)}`;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

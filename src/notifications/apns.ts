import { sign } from "node:crypto";
import { connect } from "node:http2";
import type {
  ActivityPush,
  Push,
  PushEnvironment,
  PushMessage,
} from "./notifications.ts";

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
 * Sends pushes through the Apple Push Notification service: alerts to devices, and the updates of Live Activities to
 * each activity's own token. Both share one provider token, which APNs lets change only every 20 minutes. APNs speaks
 * only HTTP/2, which Bun's `fetch` does not, so this uses `node:http2`.
 */
export function apnsPush(key: ApnsKey): {
  readonly push: Push;
  readonly activityPush: ActivityPush;
} {
  const send = apnsSender(key);
  return {
    push: (device, message) =>
      send(
        device.environment,
        device.token,
        key.topic,
        "alert",
        10,
        apnsPayload(message)
      ),
    activityPush: (environment, token, payload, priority) =>
      send(
        environment,
        token,
        `${key.topic}.push-type.liveactivity`,
        "liveactivity",
        priority,
        payload
      ),
  };
}

function apnsSender(key: ApnsKey) {
  let token = { value: "", at: 0 };
  return (
    environment: PushEnvironment,
    deviceToken: string,
    topic: string,
    pushType: "alert" | "liveactivity",
    priority: 5 | 10,
    payload: object
  ) => {
    if (Date.now() - token.at > TOKEN_AGE) {
      token = { value: providerToken(key), at: Date.now() };
    }
    // A family sends few pushes, so each gets its own connection and none needs to be kept alive.
    const session = connect(HOSTS[environment]);
    return new Promise<"sent" | "gone">((resolve, reject) => {
      session.on("error", reject);
      const stream = session.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${token.value}`,
        "apns-topic": topic,
        "apns-push-type": pushType,
        "apns-priority": String(priority),
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
        const outcome = apnsOutcome(status, body);
        if (outcome instanceof Error) {
          return reject(outcome);
        }
        resolve(outcome);
      });
      stream.end(JSON.stringify(payload));
    }).finally(() => session.close());
  };
}

/** What an APNs answer means; a body that is not JSON, such as a proxy's error page, has no reason. */
export function apnsOutcome(
  status: number,
  body: string
): "sent" | "gone" | Error {
  if (status === 200) {
    return "sent";
  }
  let reason: string | undefined;
  try {
    reason = (JSON.parse(body) as { reason?: string } | null)?.reason;
  } catch {
    reason = undefined;
  }
  if (status === 410 || GONE.has(reason ?? "")) {
    return "gone";
  }
  return new Error(`APNs answered ${status}: ${reason ?? body}`);
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

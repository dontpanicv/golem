import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { Connector } from "./integrations.ts";

/** Salus's iT500 cloud (Arrayent) in Europe, which the RT310i app uses since Salus closed salus-it500.com. */
const HOST = "https://sal-emea-p01-api.arrayent.com";
/** How long one call to Salus may take. */
const TIMEOUT_MS = 20 * 1000;
/** Salus answers an expired security token with HTTP 500 and this fault. */
const TOKEN_EXPIRED = "<errorCode>106</errorCode>";

/** What Golem keeps of a Salus account: its email and the MD5 of the password that Salus took. */
interface Account {
  readonly email: string;
  readonly hash: string;
}

interface Session {
  readonly userId: string;
  readonly token: string;
}

/**
 * Salus iT500 thermostats, such as the RT310i, through the Arrayent API of Salus's apps
 * (https://github.com/Peterka35/salus-it500-cloud). It is not a public API: Salus can change it.
 */
export function salusConnector(request: typeof fetch = fetch): Connector {
  /** One session for each account while Golem runs; Salus ends it after a while, and Golem signs in again. */
  const sessions = new Map<string, Promise<Session>>();

  /** Calls the API as Salus's apps do: a call that reads sends a form, and a change sends a query. */
  async function call(
    secret: string,
    method: "GET" | "POST",
    name: string,
    parameters: Record<string, string>,
    signal: AbortSignal | undefined
  ): Promise<string> {
    const account = JSON.parse(secret) as Account;
    for (const attempt of [1, 2]) {
      let session = sessions.get(account.hash);
      if (!session) {
        session = signIn(account.email, account.hash, signal).then(
          (signedIn) => {
            if (!signedIn) {
              throw new Error(
                "Salus refused the email or password; add the Salus credential again"
              );
            }
            return signedIn;
          }
        );
        session.catch(() => sessions.delete(account.hash));
        sessions.set(account.hash, session);
      }
      const { userId, token } = await session;
      const query = new URLSearchParams({
        userId,
        ...parameters,
        secToken: token,
      });
      const response = await request(
        `${HOST}/zdk/services/zamapi/${name}${method === "GET" ? `?${query}` : ""}`,
        method === "GET"
          ? { signal: withTimeout(signal) }
          : { method, body: query, signal: withTimeout(signal) }
      );
      const body = await response.text();
      if (response.ok) {
        return body;
      }
      if (attempt === 1 && tokenRejected(response.status, body)) {
        sessions.delete(account.hash);
        continue;
      }
      throw new Error(
        `Salus answered ${response.status}: ${body.slice(0, 500)}`
      );
    }
    throw new Error("Salus refused a new session");
  }

  /** The user and security token of a session, or `null` when Salus refuses the email or password. */
  async function signIn(
    email: string,
    hash: string,
    signal: AbortSignal | undefined
  ): Promise<Session | null> {
    const response = await request(
      `${HOST}/acc/applications/SalusService/sessions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: email, password: hash }),
        signal: withTimeout(signal),
      }
    );
    if (response.status === 401 || response.status === 403) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `Salus answered ${response.status}: ${(await response.text()).slice(0, 500)}`
      );
    }
    const { userId, securityToken } = (await response.json()) as {
      userId: number | string;
      securityToken: string;
    };
    return { userId: String(userId), token: securityToken };
  }

  return {
    id: "salus",
    name: "Salus",
    description:
      "Salus iT500 thermostats, such as the RT310i: the room temperature, the target temperature, whether it heats, and its mode. Set the target temperature.",
    secretLabel: "Password",
    username: "Email",
    guide: [
      "Click **Add credential**, and type the email and password of the Salus RT310i app.",
    ],
    // Salus removes special characters from a new password without a word, so a refused one is tried without them.
    secretFrom: async (input) => {
      const { username: email, secret: password } = JSON.parse(input) as {
        username: string;
        secret: string;
      };
      const stripped = password.replace(/[^a-zA-Z0-9]/g, "");
      for (const candidate of new Set([password, stripped])) {
        const hash = md5(candidate);
        if (await signIn(email, hash, undefined)) {
          return {
            label: email,
            secret: JSON.stringify({ email, hash } satisfies Account),
          };
        }
      }
      throw new Error("Salus refused the email or password");
    },
    tools: [
      {
        name: "salus_thermostats",
        description:
          "The thermostats of the Salus account, with the `id` that the other tools take.",
        parameters: Type.Object({}),
        execute: async (_, secret, signal) =>
          items(
            await call(secret, "POST", "getDeviceList", {}, signal),
            "devList"
          ).map((device) => ({ id: device.devId, name: device.devName })),
      },
      {
        name: "salus_status",
        description:
          "The room temperature and target temperature in °C of a thermostat, whether it heats now, its mode (`auto` follows its schedule, `temporary_hold` keeps a set temperature until the next step of the schedule, `manual`, or `off`), and when it last reported.",
        parameters: Type.Object({ thermostat: Type.String() }),
        execute: async ({ thermostat }, secret, signal) =>
          thermostatStatus(
            await call(
              secret,
              "POST",
              "getDeviceAttributesWithValues",
              { devId: thermostat },
              signal
            )
          ),
      },
      {
        name: "salus_set_temperature",
        description:
          "Sets the target temperature of a thermostat. In `auto` mode it holds until the next step of the schedule. The thermostat shows it within 30 seconds.",
        parameters: Type.Object({
          thermostat: Type.String(),
          temperature: Type.Number({
            minimum: 5,
            maximum: 34.5,
            multipleOf: 0.5,
            description: "In °C, in steps of 0.5.",
          }),
        }),
        execute: async ({ thermostat, temperature }, secret, signal) => {
          if (
            !Number.isInteger(temperature * 2) ||
            temperature < 5 ||
            temperature > 34.5
          ) {
            throw new Error(
              "The temperature must be from 5 to 34.5 °C, in steps of 0.5."
            );
          }
          const answer = await call(
            secret,
            "GET",
            "setMultiDeviceAttributes2",
            {
              devId: thermostat,
              name1: "A85",
              value1: String(Math.round(temperature * 100)),
            },
            signal
          );
          const code = /<retCode>(-?\d+)<\/retCode>/.exec(answer)?.[1];
          if (code !== "0") {
            throw new Error(`Salus refused the temperature (code ${code})`);
          }
          return { thermostat, targetTemperature: temperature };
        },
      },
    ],
  };
}

/** The values of a thermostat's first heating zone, from its attributes such as `A84`, in hundredths of a °C. */
export function thermostatStatus(answer: string) {
  const attributes = Object.fromEntries(
    items(answer, "attrList").map((attribute) => [
      attribute.name,
      attribute.value,
    ])
  );
  const times = items(answer, "attrList")
    .map((attribute) => Number(attribute.updTime))
    .filter(Number.isFinite);
  const presence = /<presenceInfo>(\d)<\/presenceInfo>/.exec(answer)?.[1];
  return {
    name: attributes.desc ?? null,
    roomTemperature: degrees(attributes.A84),
    targetTemperature: degrees(attributes.A85),
    heating: attributes.A87 === "1",
    mode: modeOf(attributes),
    connected: presence === undefined ? null : presence === "1",
    reportedAt: times.length
      ? new Date(Math.max(...times)).toISOString()
      : null,
  };
}

/** The elements `<tag>` of a Salus answer, each as the text of its children; the answers are small and flat. */
function items(xml: string, tag: string): Record<string, string>[] {
  return [
    ...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")),
  ].map(([, inner]) =>
    Object.fromEntries(
      [...inner!.matchAll(/<(\w+)>([^<]*)<\/\1>/g)].map(([, name, text]) => [
        name,
        unescapeXml(text!),
      ])
    )
  );
}

function unescapeXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** `auto` follows the schedule; `temporary_hold` keeps a set temperature until its next step. */
function modeOf(attributes: Record<string, string | undefined>): string {
  if (attributes.A89 === "1") {
    return "off";
  }
  if (attributes.A92 === "1") {
    return "manual";
  }
  return attributes.A88 === "1" ? "temporary_hold" : "auto";
}

function degrees(hundredths: string | undefined): number | null {
  return hundredths === undefined ? null : Number(hundredths) / 100;
}

function tokenRejected(status: number, body: string): boolean {
  return status === 401 || status === 403 || body.includes(TOKEN_EXPIRED);
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

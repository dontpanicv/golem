import { Type } from "@earendil-works/pi-ai";
import type { Connector } from "./integrations.ts";
import { PASTE_ADDRESS, SIGN_IN_ADDRESS } from "./sign-in.ts";

const API = "https://api.netatmo.com";
/** How long one call to Netatmo may take. */
const TIMEOUT_MS = 30 * 1000;

/** A module of a weather station as Netatmo gives it; the station itself is its main, indoor module. */
interface StationModule {
  readonly _id: string;
  readonly module_name?: string;
  readonly type: string;
  readonly reachable?: boolean;
  readonly battery_percent?: number;
  readonly dashboard_data?: Record<string, unknown>;
}

interface Station extends StationModule {
  readonly station_name?: string;
  readonly home_name?: string;
  readonly modules?: readonly StationModule[];
}

/**
 * Netatmo weather stations through Netatmo's API (https://dev.netatmo.com/apidocumentation/weather), with a sign-in to
 * the app that the server's owner made at dev.netatmo.com. Agents only read.
 */
export function netatmoConnector(request: typeof fetch = fetch): Connector {
  async function call<Body>(
    token: string,
    path: string,
    parameters: Record<string, string>,
    signal: AbortSignal | undefined
  ): Promise<Body> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await request(
      `${API}/api/${path}?${new URLSearchParams(parameters)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }
    );
    const answer = (await response.json().catch(() => ({}))) as {
      body?: Body;
      error?: { message?: string };
    };
    if (!(response.ok && answer.body)) {
      throw new Error(
        `Netatmo answered ${response.status}: ${answer.error?.message ?? "no data"}`
      );
    }
    return answer.body;
  }

  return {
    id: "netatmo",
    name: "Netatmo",
    description:
      "The person's Netatmo weather stations: the current temperature, humidity, CO₂, noise, and pressure of each module, indoor and outdoor, and their history. Read only.",
    secretLabel: null,
    oauth: API,
    oauthEndpoints: {
      authorization: `${API}/oauth2/authorize`,
      token: `${API}/oauth2/token`,
    },
    registered: true,
    scope: "read_station",
    guide: [
      "At [dev.netatmo.com](https://dev.netatmo.com/apps/createanapp), sign in, and create an app with the required fields.",
      `In **Redirect URI**, type \`${SIGN_IN_ADDRESS}\`. Save the app, and copy its client ID and client secret.`,
      "Click **Client** here, and paste them.",
      "Click **Connect**, sign in to Netatmo, and accept.",
      PASTE_ADDRESS,
    ],
    tools: [
      {
        name: "netatmo_stations",
        description:
          "The weather stations, each with its modules: the indoor one with the station's `id`, and the outdoor and other ones. Each module gives its current values, such as `Temperature` (°C), `Humidity` (%), `CO2` (ppm), `Noise` (dB), and `Pressure` (mbar), the day's `min_temp` and `max_temp`, and when it measured them.",
        parameters: Type.Object({}),
        execute: async (_, token, signal) =>
          (
            await call<{ devices: Station[] }>(
              token,
              "getstationsdata",
              { get_favorites: "false" },
              signal
            )
          ).devices.map((station) => ({
            id: station._id,
            name: station.station_name ?? station.home_name ?? null,
            modules: [station, ...(station.modules ?? [])].map(stationModule),
          })),
      },
      {
        name: "netatmo_measure",
        description:
          "The history of a module's values, oldest first. Each measurement has its time and one value for each type.",
        parameters: Type.Object({
          station: Type.String({ description: "The station's `id`." }),
          module: Type.Optional(
            Type.String({
              description:
                "The `id` of an outdoor or other module; the indoor module when not given.",
            })
          ),
          types: Type.Array(Type.String(), {
            minItems: 1,
            description:
              "Such as `temperature`, `humidity`, `co2`, `pressure`, and `noise`; with a scale of `1day` or more also `min_temp` and `max_temp`.",
          }),
          scale: Type.Union([
            Type.Literal("30min"),
            Type.Literal("1hour"),
            Type.Literal("3hours"),
            Type.Literal("1day"),
            Type.Literal("1week"),
            Type.Literal("1month"),
          ]),
          start: Type.String({ description: "An ISO 8601 time." }),
          end: Type.Optional(
            Type.String({
              description: "An ISO 8601 time; now when not given.",
            })
          ),
        }),
        execute: async (
          { station, module, types, scale, start, end },
          token,
          signal
        ) => {
          const measurements = await call<Record<string, (number | null)[]>>(
            token,
            "getmeasure",
            {
              device_id: station,
              ...(module ? { module_id: module } : {}),
              type: types.join(","),
              scale,
              date_begin: String(seconds(start)),
              ...(end ? { date_end: String(seconds(end)) } : {}),
              optimize: "false",
              real_time: "true",
            },
            signal
          );
          return Object.entries(measurements).map(([time, values]) => ({
            time: new Date(Number(time) * 1000).toISOString(),
            ...Object.fromEntries(
              types.map((type: string, index: number) => [
                type,
                values[index] ?? null,
              ])
            ),
          }));
        },
      },
    ],
  };
}

/** A module with its values; Netatmo's times, in seconds, become ISO 8601. */
function stationModule(module: StationModule) {
  return {
    id: module._id,
    name: module.module_name ?? null,
    type: module.type,
    reachable: module.reachable ?? null,
    batteryPercent: module.battery_percent ?? null,
    values: Object.fromEntries(
      Object.entries(module.dashboard_data ?? {}).map(([name, value]) => [
        name,
        (name === "time_utc" || name.startsWith("date_")) &&
        typeof value === "number"
          ? new Date(value * 1000).toISOString()
          : value,
      ])
    ),
  };
}

function seconds(time: string): number {
  const milliseconds = Date.parse(time);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Not an ISO 8601 time: ${time}`);
  }
  return Math.floor(milliseconds / 1000);
}

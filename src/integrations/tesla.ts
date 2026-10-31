import {
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Connector, Keeper } from "./integrations.ts";
import { PASTE_ADDRESS, SIGN_IN_ADDRESS } from "./sign-in.ts";

const AUTH = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3";
/** The regions of the Fleet API where Golem registers its domain; China has its own sign-in, which Golem does not use. */
const REGIONS = [
  "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  "https://fleet-api.prd.na.vn.cloud.tesla.com",
];
const SCOPES = [
  "openid",
  "offline_access",
  "vehicle_device_data",
  "vehicle_location",
  "vehicle_cmds",
  "vehicle_charging_cmds",
];
/** Where the Fleet API reads the public key of Golem's signing key, on Golem's own address. */
export const PUBLIC_KEY_PATH =
  "/.well-known/appspecific/com.tesla.3p.public-key.pem";
/** How long one call to the Fleet API may take. */
const TIMEOUT_MS = 30 * 1000;
/** How long one command may take, with the time that the car takes to wake. */
const COMMAND_MS = 90 * 1000;
const WAKE_MS = 60 * 1000;
/** Tesla bills each call: the charge log looks at each car every 30 minutes, and every 5 minutes while it charges. */
const IDLE_MS = 30 * 60 * 1000;
const CHARGING_MS = 5 * 60 * 1000;
const KM_PER_MILE = 1.609_344;

/** The commands that act without the person's approval, and the arguments of tesla-control for each. */
const COMMANDS = {
  climate_on: () => ["climate-on"],
  climate_off: () => ["climate-off"],
  set_temperature: ({ celsius }) => [
    "climate-set-temp",
    `${needed(celsius, "celsius")}c`,
  ],
  seat_heater: ({ seat, level }) => [
    "seat-heater",
    needed(seat, "seat"),
    needed(level, "level"),
  ],
  steering_wheel_heater: ({ on }) => [
    "steering-wheel-heater",
    needed(on, "on") ? "on" : "off",
  ],
  charge_start: () => ["charging-start"],
  charge_stop: () => ["charging-stop"],
  charge_limit: ({ percent }) => [
    "charging-set-limit",
    String(needed(percent, "percent")),
  ],
  charge_amps: ({ amps }) => [
    "charging-set-amps",
    String(needed(amps, "amps")),
  ],
  charge_port_open: () => ["charge-port-open"],
  charge_port_close: () => ["charge-port-close"],
  lock: () => ["lock"],
  close_windows: () => ["windows-close"],
  sentry_on: () => ["sentry-mode", "on"],
  flash_lights: () => ["flash-lights"],
  honk: () => ["honk"],
} satisfies Record<string, (args: CommandArguments) => string[]>;

/** The actions that open the car, which the person allows each time. */
const OPENS = {
  unlock: { arguments: ["unlock"], text: "Unlock" },
  open_trunk: { arguments: ["trunk-open"], text: "Open the trunk of" },
  open_frunk: { arguments: ["frunk-open"], text: "Open the frunk of" },
  vent_windows: { arguments: ["windows-vent"], text: "Vent the windows of" },
  sentry_off: {
    arguments: ["sentry-mode", "off"],
    text: "Turn off Sentry Mode of",
  },
} as const;

interface CommandArguments {
  readonly celsius?: number;
  readonly seat?: string;
  readonly level?: string;
  readonly on?: boolean;
  readonly percent?: number;
  readonly amps?: number;
}

/** A car as the Fleet API lists it; listing does not wake it. */
interface Vehicle {
  readonly vin: string;
  readonly display_name?: string | null;
  readonly state: string;
}

/** The parts of `vehicle_data` that Golem reads; the Fleet API gives distances in miles. */
interface VehicleData extends Vehicle {
  readonly charge_state?: Record<string, unknown>;
  readonly climate_state?: Record<string, unknown>;
  readonly drive_state?: Record<string, unknown>;
  readonly vehicle_state?: Record<string, unknown>;
}

/** What the charge log reads of a car that is online. */
export interface Sample {
  readonly time: number;
  /** `charging_state`, such as `Charging`, `Complete`, `Stopped`, or `Disconnected`. */
  readonly state: string;
  readonly batteryLevel: number | null;
  /** The kWh that the car put into its battery in its current or last charge session. */
  readonly energyAdded: number;
  readonly volts: number;
  readonly amps: number;
  readonly phases: number;
  readonly fastCharger: boolean;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

/** A charge session that the log follows. */
interface Session {
  readonly start: number;
  readonly end: number;
  /** `energyAdded` of the plug-in before this session; the car counts on from it when it charges again. */
  readonly base: number;
  readonly first: Sample;
  readonly last: Sample;
  /** The kWh from the wall, and into the battery, between the first and the last sample while the car charged. */
  readonly wallKwh: number;
  readonly seenKwh: number;
}

/** What the log keeps of each car. */
export interface CarLog {
  readonly last?: Sample;
  /** The cable was out since `last`, so the car counts from zero at its next charge. */
  readonly unplugged?: boolean;
  readonly session?: Session;
}

/** A charge session as the tools give it. */
export interface Charge {
  readonly start: string;
  readonly end: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly startBatteryLevel: number | null;
  readonly endBatteryLevel: number | null;
  /** The kWh into the battery, which the car counts. */
  readonly batteryKwh: number;
  /** The kWh from the wall; `null` at a fast charger, or when the log saw too little of the session. */
  readonly wallKwh: number | null;
  readonly volts: number;
  readonly amps: number;
  readonly phases: number;
  readonly fastCharger: boolean;
}

export interface TeslaOptions {
  /** The path of tesla-control, which signs the commands. */
  readonly binary: string;
  /** Where Golem keeps its signing key. */
  readonly directory: string;
  /** Golem's domain, where the Fleet API reads the public key. */
  readonly domain: string;
  readonly request?: typeof fetch;
  /** Runs tesla-control with its arguments; tests pass their own. */
  readonly run?: (
    command: readonly string[],
    signal: AbortSignal | undefined
  ) => Promise<void>;
  readonly pause?: (milliseconds: number) => Promise<void>;
}

/**
 * Tesla cars through the Fleet API (https://developer.tesla.com/docs/fleet-api), with a sign-in to the app that the
 * server's owner made at developer.tesla.com. Agents read the cars and send commands, which tesla-control
 * (https://github.com/teslamotors/vehicle-command) signs with Golem's key; the cars take them after the person adds
 * that key in the Tesla app. While Golem runs, it logs the charge sessions of each account.
 */
export function teslaConnector(options: TeslaOptions): Connector {
  const request = options.request ?? fetch;
  const pause = options.pause ?? Bun.sleep;
  const keyFile = signingKey(options.directory);
  const run = options.run ?? spawner(options.binary, keyFile);
  const fleet = <Result>(
    token: string,
    path: string,
    signal: AbortSignal | undefined,
    body?: unknown
  ) => call<Result>(request, token, path, signal, body);

  /** The car of `vin`, else the only car of the account. */
  async function vehicle(
    token: string,
    vin: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<Vehicle> {
    if (vin) {
      return fleet<Vehicle>(token, `api/1/vehicles/${vin}`, signal);
    }
    const vehicles = await fleet<Vehicle[]>(token, "api/1/vehicles", signal);
    if (vehicles.length !== 1) {
      throw new Error(
        vehicles.length === 0
          ? "The Tesla account has no car."
          : `Name the car with \`vin\`: ${vehicles.map((car) => `${car.vin} (${car.display_name})`).join(", ")}.`
      );
    }
    return vehicles[0]!;
  }

  /** Wakes the car when it sleeps, which takes some seconds, and Tesla bills more than other calls. */
  async function awake(
    token: string,
    car: Vehicle,
    signal: AbortSignal | undefined
  ): Promise<void> {
    if (car.state === "online") {
      return;
    }
    await fleet(token, `api/1/vehicles/${car.vin}/wake_up`, signal, {});
    for (const deadline = Date.now() + WAKE_MS; Date.now() < deadline; ) {
      await pause(3000);
      const { state } = await fleet<Vehicle>(
        token,
        `api/1/vehicles/${car.vin}`,
        signal
      );
      if (state === "online") {
        return;
      }
    }
    throw new Error(
      "The car did not wake up in a minute; it may have no signal."
    );
  }

  async function send(
    secret: string,
    vin: string | undefined,
    command: readonly string[],
    signal: AbortSignal | undefined
  ) {
    const { store, secret: token } = account(secret);
    const car = await vehicle(token, vin, signal);
    await awake(token, car, signal);
    mkdirSync(store, { recursive: true });
    await run(
      [
        "-vin",
        car.vin,
        "-session-cache",
        join(store, "sessions.json"),
        "-token",
        token,
        ...command,
      ],
      signal
    );
    return { done: true, vin: car.vin };
  }

  const log = chargeLog(fleet);
  return {
    id: "tesla",
    name: "Tesla",
    description:
      "The person's Tesla cars: battery, charging, climate, location, and locks, and the charge sessions that Golem logs, with the kWh into the battery and from the wall. Preheat or cool the car, set charging, and lock it; unlocking and opening ask the person first.",
    secretLabel: null,
    oauth: AUTH,
    oauthEndpoints: {
      authorization: `${AUTH}/authorize`,
      token: `${AUTH}/token`,
    },
    registered: true,
    scope: SCOPES.join(" "),
    // Tesla asks again for scopes that the person did not allow before.
    authorizationParameters: { prompt_missing_scopes: "true" },
    guide: [
      "At [developer.tesla.com](https://developer.tesla.com), sign in with the Tesla account, and create an app. Select **Authorization Code and Machine-to-Machine**, and the scopes **Vehicle Information**, **Vehicle Location**, **Vehicle Commands**, and **Vehicle Charging Management**.",
      `In **Allowed Origin(s)**, type \`https://${options.domain}\`, and in **Allowed Redirect URI(s)**, \`${SIGN_IN_ADDRESS}\`. Copy the client ID and the client secret.`,
      `Click **Client** here, and paste them. Golem registers \`${options.domain}\` with Tesla, which reads Golem's key at \`https://${options.domain}${PUBLIC_KEY_PATH}\`.`,
      "Click **Connect**, sign in to Tesla, and allow all the scopes.",
      PASTE_ADDRESS,
      `For commands, open [tesla.com/_ak/${options.domain}](https://tesla.com/_ak/${options.domain}) on the phone with the Tesla app, and add the key to each car.`,
    ],
    publicKey: () =>
      createPublicKey(readFileSync(keyFile))
        .export({ type: "spki", format: "pem" })
        .toString(),
    registerClient: async ({ clientId, clientSecret }) => {
      for (const region of REGIONS) {
        const answer = await request(`${AUTH}/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
            scope: SCOPES.filter((scope) => scope !== "offline_access").join(
              " "
            ),
            audience: region,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const { access_token: token } = (await answer
          .json()
          .catch(() => ({}))) as { access_token?: string };
        if (!(answer.ok && token)) {
          throw new Error(
            `Tesla refused the client ID and secret (${answer.status})`
          );
        }
        const registered = await request(`${region}/api/1/partner_accounts`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ domain: options.domain }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!registered.ok) {
          throw new Error(
            `Tesla did not register ${options.domain}: ${(await registered.text()).slice(0, 300)}`
          );
        }
      }
    },
    keeper: log.keeper,
    tools: [
      {
        name: "tesla_vehicles",
        description:
          "The cars of the account, each with its `vin`, name, and `state`: `online`, `asleep`, or `offline`. It does not wake them.",
        parameters: Type.Object({}),
        execute: async (_, secret, signal) =>
          (
            await fleet<Vehicle[]>(
              account(secret).secret,
              "api/1/vehicles",
              signal
            )
          ).map(({ vin, display_name, state }) => ({
            vin,
            name: display_name ?? null,
            state,
          })),
      },
      {
        name: "tesla_vehicle",
        description:
          "A car's battery, charging, climate, location, locks, doors, windows, and tires, in km, °C, and bar. A car that sleeps gives its state and what the charge log last saw, unless `wake` is true; Tesla bills a wake more than other calls.",
        parameters: Type.Object({
          vin: Type.Optional(
            Type.String({
              description: "The car; the only one when not given.",
            })
          ),
          wake: Type.Optional(Type.Boolean()),
        }),
        execute: async ({ vin, wake }, secret, signal) => {
          const { store, secret: token } = account(secret);
          const car = await vehicle(token, vin, signal);
          if (car.state !== "online" && !wake) {
            const last = readLog(store).cars[car.vin]?.last;
            return {
              vin: car.vin,
              name: car.display_name ?? null,
              state: car.state,
              lastSeen: last
                ? {
                    time: new Date(last.time).toISOString(),
                    batteryLevel: last.batteryLevel,
                    charging: last.state,
                    latitude: last.latitude,
                    longitude: last.longitude,
                  }
                : null,
            };
          }
          await awake(token, car, signal);
          return summary(
            await fleet<VehicleData>(
              token,
              `api/1/vehicles/${car.vin}/vehicle_data?${new URLSearchParams({
                endpoints:
                  "charge_state;climate_state;drive_state;location_data;vehicle_state",
              })}`,
              signal
            )
          );
        },
      },
      {
        name: "tesla_command",
        description:
          "Sends a command to a car, and wakes it first when it sleeps. `climate_on` preheats or cools the cabin to the set temperature. `set_temperature` takes `celsius`, `seat_heater` takes `seat` and `level`, `steering_wheel_heater` takes `on`, `charge_limit` takes `percent` (50–100), and `charge_amps` takes `amps`.",
        parameters: Type.Object({
          command: Type.Union(
            Object.keys(COMMANDS).map((name) => Type.Literal(name))
          ),
          vin: Type.Optional(Type.String()),
          celsius: Type.Optional(Type.Number({ minimum: 15, maximum: 28 })),
          seat: Type.Optional(
            Type.Union(
              [
                "front-left",
                "front-right",
                "2nd-row-left",
                "2nd-row-center",
                "2nd-row-right",
              ].map((seat) => Type.Literal(seat))
            )
          ),
          level: Type.Optional(
            Type.Union(
              ["off", "low", "medium", "high"].map((level) =>
                Type.Literal(level)
              )
            )
          ),
          on: Type.Optional(Type.Boolean()),
          percent: Type.Optional(Type.Integer({ minimum: 50, maximum: 100 })),
          amps: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })),
        }),
        execute: async ({ command: name, vin, ...rest }, secret, signal) =>
          send(
            secret,
            vin,
            COMMANDS[name as keyof typeof COMMANDS](rest as CommandArguments),
            signal
          ),
      },
      {
        name: "tesla_open",
        description:
          "Unlocks a car, opens its trunk or frunk, vents its windows, or turns off Sentry Mode, after the person allows it.",
        parameters: Type.Object({
          action: Type.Union(
            Object.keys(OPENS).map((name) => Type.Literal(name))
          ),
          vin: Type.Optional(Type.String()),
        }),
        approval: ({ action, vin }) =>
          `${OPENS[action as keyof typeof OPENS].text} the Tesla${vin ? ` ${vin}` : ""}`,
        execute: async ({ action, vin }, secret, signal) =>
          send(
            secret,
            vin,
            OPENS[action as keyof typeof OPENS].arguments,
            signal
          ),
      },
      {
        name: "tesla_charges",
        description:
          "The charge sessions that Golem logged, oldest first, with the place, the battery levels, the kWh into the battery, and the kWh from the wall, which Golem adds up from the charger's volts, amps, and phases. A session that goes on has `ongoing`. Golem looks at each car every 30 minutes, so a session can start up to 30 minutes before its `start`; its kWh are whole.",
        parameters: Type.Object({
          vin: Type.Optional(Type.String()),
          from: Type.Optional(
            Type.String({ description: "An ISO 8601 time." })
          ),
          to: Type.Optional(Type.String({ description: "An ISO 8601 time." })),
        }),
        execute: async ({ vin, from, to }, secret) =>
          log.charges(account(secret).store, vin, from, to),
      },
    ],
  };
}

/** What a tool of a connector with a keeper gets: the credential's store and its access token. */
function account(secret: string): { store: string; secret: string } {
  return JSON.parse(secret) as { store: string; secret: string };
}

/** Calls the Fleet API in the region of the token. */
async function call<Result>(
  request: typeof fetch,
  token: string,
  path: string,
  signal: AbortSignal | undefined,
  body?: unknown
): Promise<Result> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await request(new URL(path, `${regionOf(token)}/`), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const answer = (await response.json().catch(() => ({}))) as {
    response?: Result;
    error?: string;
  };
  if (!response.ok || answer.response === undefined) {
    throw new Error(
      response.status === 408
        ? "The car sleeps or has no signal."
        : `Tesla answered ${response.status}: ${answer.error ?? "no data"}`
    );
  }
  return answer.response;
}

/** The Fleet API of the account's region, from the audiences of its token, as tesla-control finds it. */
export function regionOf(token: string): string {
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}"
  ) as { aud?: string | string[]; ou_code?: string };
  const audiences = [claims.aud ?? []]
    .flat()
    .filter((audience) => audience.startsWith("https://fleet-api."))
    .map((audience) => audience.replace(/\/+$/, ""));
  const region = claims.ou_code?.toLowerCase();
  const api =
    audiences.find((audience) => region && audience.includes(`.${region}.`)) ??
    audiences[0];
  if (!api) {
    throw new Error("Tesla's token names no region. Connect Tesla again.");
  }
  return api;
}

/** The parts of a car's data that people ask about, in km. */
function summary(data: VehicleData) {
  const charge = fields(data.charge_state);
  const climate = fields(data.climate_state);
  const drive = fields(data.drive_state);
  const state = fields(data.vehicle_state);
  const open = (names: string[]) => names.filter((name) => state(name));
  return {
    vin: data.vin,
    name: data.display_name ?? null,
    state: data.state,
    battery: {
      level: charge("battery_level"),
      rangeKm: km(charge("battery_range")),
      chargeLimit: charge("charge_limit_soc"),
    },
    charging: {
      state: charge("charging_state"),
      energyAddedKwh: charge("charge_energy_added"),
      powerKw: charge("charger_power"),
      volts: charge("charger_voltage"),
      amps: charge("charger_actual_current"),
      requestedAmps: charge("charge_current_request"),
      phases: charge("charger_phases"),
      minutesToFull: charge("minutes_to_full_charge"),
      fastCharger: charge("fast_charger_present"),
      portOpen: charge("charge_port_door_open"),
    },
    climate: {
      on: climate("is_climate_on"),
      preconditioning: climate("is_preconditioning"),
      insideCelsius: climate("inside_temp"),
      outsideCelsius: climate("outside_temp"),
      setCelsius: climate("driver_temp_setting"),
      seatHeaters: {
        frontLeft: climate("seat_heater_left"),
        frontRight: climate("seat_heater_right"),
      },
      steeringWheelHeater: climate("steering_wheel_heater"),
    },
    location: {
      latitude: drive("latitude"),
      longitude: drive("longitude"),
      speedKmh: km(drive("speed")),
      shift: drive("shift_state"),
    },
    vehicle: {
      locked: state("locked"),
      sentryMode: state("sentry_mode"),
      odometerKm: km(state("odometer")),
      software: state("car_version"),
      // The car gives 0 for a closed door, window, trunk, and frunk.
      openDoors: open(["df", "pf", "dr", "pr"]),
      openWindows: open(["fd_window", "fp_window", "rd_window", "rp_window"]),
      openTrunks: open(["rt", "ft"]).map((name) =>
        name === "rt" ? "trunk" : "frunk"
      ),
      tirePressureBar: {
        frontLeft: state("tpms_pressure_fl"),
        frontRight: state("tpms_pressure_fr"),
        rearLeft: state("tpms_pressure_rl"),
        rearRight: state("tpms_pressure_rr"),
      },
    },
  };
}

/** Reads the fields of one part of a car's data; a field that it does not give is `null`. */
function fields(
  part: Record<string, unknown> | undefined
): (name: string) => unknown {
  return (name) => part?.[name] ?? null;
}

function km(miles: unknown): number | null {
  return typeof miles === "number"
    ? Math.round(miles * KM_PER_MILE * 10) / 10
    : null;
}

/** The charge log: a keeper that looks at each car of an account, and the sessions that it kept in the store. */
function chargeLog(
  fleet: <Result>(
    token: string,
    path: string,
    signal: AbortSignal | undefined
  ) => Promise<Result>
): {
  keeper: Keeper;
  charges: (
    store: string,
    vin?: string,
    from?: string,
    to?: string
  ) => (Charge & { vin: string; ongoing?: true })[];
} {
  const timers = new Map<string, Timer>();

  /** Looks at each car once, keeps what changed, and gives how long to wait until the next time. */
  async function look(store: string, token: string): Promise<number> {
    const vehicles = await fleet<Vehicle[]>(token, "api/1/vehicles", undefined);
    const log = readLog(store);
    for (const car of vehicles) {
      let sample: Sample | null = null;
      if (car.state === "online") {
        try {
          sample = sampleOf(
            await fleet<VehicleData>(
              token,
              `api/1/vehicles/${car.vin}/vehicle_data?${new URLSearchParams({
                endpoints: "charge_state;location_data",
              })}`,
              undefined
            ),
            Date.now()
          );
        } catch {
          // It fell asleep since the list; look again next time.
          continue;
        }
      }
      const { car: next, charge } = chargeStep(log.cars[car.vin] ?? {}, sample);
      log.cars[car.vin] = next;
      if (charge) {
        appendFileSync(
          join(store, "charges.jsonl"),
          `${JSON.stringify({ vin: car.vin, ...charge })}\n`
        );
      }
    }
    writeFileSync(join(store, "tesla.json"), JSON.stringify(log));
    return Object.values(log.cars).some((car) => car.session)
      ? CHARGING_MS
      : IDLE_MS;
  }

  return {
    keeper: {
      keep: (store, secret) => {
        mkdirSync(store, { recursive: true });
        const tick = async () => {
          let wait = IDLE_MS;
          try {
            wait = await look(store, await secret());
          } catch (error) {
            console.error("the Tesla charge log failed", error);
          }
          if (timers.has(store)) {
            timers.set(store, setTimeout(tick, wait));
          }
        };
        timers.set(store, setTimeout(tick, 0));
      },
      stop: (store) => {
        clearTimeout(timers.get(store));
        timers.delete(store);
      },
      close: () => {
        for (const timer of timers.values()) {
          clearTimeout(timer);
        }
        timers.clear();
      },
    },
    charges: (store, vin, from, to) => {
      const start = from ? Date.parse(from) : 0;
      const end = to ? Date.parse(to) : Number.POSITIVE_INFINITY;
      const file = join(store, "charges.jsonl");
      const kept = existsSync(file)
        ? readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Charge & { vin: string })
        : [];
      const ongoing = Object.entries(readLog(store).cars).flatMap(
        ([carVin, car]) =>
          car.session
            ? [{ vin: carVin, ...finish(car.session), ongoing: true as const }]
            : []
      );
      return [...kept, ...ongoing].filter(
        (charge) =>
          (!vin || charge.vin === vin) &&
          Date.parse(charge.end) >= start &&
          Date.parse(charge.start) <= end
      );
    },
  };
}

function readLog(store: string): { cars: Record<string, CarLog> } {
  const file = join(store, "tesla.json");
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as {
        cars: Record<string, CarLog>;
      })
    : { cars: {} };
}

/** What the log keeps of a car's data. */
function sampleOf(data: VehicleData, time: number): Sample {
  const charge = data.charge_state ?? {};
  const drive = data.drive_state ?? {};
  const volts = Number(charge.charger_voltage) || 0;
  const amps = Number(charge.charger_actual_current) || 0;
  const powerKw = Number(charge.charger_power) || 0;
  // The car gives its power in whole kW, and some give 2 phases on 3; the power tells how many carry current.
  const measured =
    volts * amps > 0 ? Math.round((powerKw * 1000) / (volts * amps)) : 0;
  return {
    time,
    state: String(charge.charging_state ?? "Unknown"),
    batteryLevel:
      typeof charge.battery_level === "number" ? charge.battery_level : null,
    energyAdded: Number(charge.charge_energy_added) || 0,
    volts,
    amps,
    phases:
      measured >= 1 && measured <= 3
        ? measured
        : Number(charge.charger_phases) || 1,
    fastCharger: charge.fast_charger_present === true,
    latitude: typeof drive.latitude === "number" ? drive.latitude : null,
    longitude: typeof drive.longitude === "number" ? drive.longitude : null,
  };
}

/**
 * Takes one look at a car into its log: `sample` is `null` while it sleeps. A session starts when the car charges, and
 * ends with the first look at which it does not; then it gives the `charge`.
 */
export function chargeStep(
  car: CarLog,
  sample: Sample | null
): { car: CarLog; charge?: Charge } {
  const charging =
    sample !== null &&
    (sample.state === "Charging" || sample.state === "Starting");
  const { session } = car;
  const charge =
    session && !charging ? finish(ended(session, sample)) : undefined;
  let next: Session | undefined;
  if (charging) {
    next = session ? extended(session, sample) : opened(car, sample);
  }
  const last = sample ?? car.last;
  return {
    car: {
      ...(last ? { last } : {}),
      unplugged:
        !charging &&
        (car.unplugged === true || sample?.state === "Disconnected"),
      ...(next ? { session: next } : {}),
    },
    ...(charge ? { charge } : {}),
  };
}

/** A new session; the car counts on from the last session while the cable stayed in. */
function opened(car: CarLog, sample: Sample): Session {
  const countsOn =
    !car.unplugged &&
    car.last !== undefined &&
    sample.energyAdded >= car.last.energyAdded;
  return {
    start: sample.time,
    end: sample.time,
    base: countsOn ? car.last!.energyAdded : 0,
    first: sample,
    last: sample,
    wallKwh: 0,
    seenKwh: 0,
  };
}

/** A session with one more look, while the car charges: the wall's power between two looks is their average. */
function extended(session: Session, sample: Sample): Session {
  const hours = (sample.time - session.last.time) / 3_600_000;
  return {
    ...session,
    end: sample.time,
    last: sample,
    wallKwh:
      session.wallKwh + ((wallKw(session.last) + wallKw(sample)) / 2) * hours,
    seenKwh: sample.energyAdded - session.first.energyAdded,
  };
}

/** A session at its end: the car's last count, with the charger's values of the last look while it charged. */
function ended(session: Session, sample: Sample | null): Session {
  if (!sample) {
    return session;
  }
  const { volts, amps, phases } = session.last;
  return {
    ...session,
    end: sample.time,
    last: { ...sample, volts, amps, phases },
  };
}

/** A session as a charge: the kWh from the wall for the whole session, at the ratio that the log saw. */
function finish(session: Session): Charge {
  const { first, last } = session;
  const batteryKwh = last.energyAdded - session.base;
  const { seenKwh } = session;
  return {
    start: new Date(session.start).toISOString(),
    end: new Date(session.end).toISOString(),
    latitude: first.latitude,
    longitude: first.longitude,
    startBatteryLevel: first.batteryLevel,
    endBatteryLevel: last.batteryLevel,
    batteryKwh: round(batteryKwh),
    wallKwh:
      first.fastCharger || seenKwh < 0.5
        ? null
        : round((batteryKwh * session.wallKwh) / seenKwh),
    volts: last.volts,
    amps: last.amps,
    phases: last.phases,
    fastCharger: first.fastCharger,
  };
}

function wallKw(sample: Sample): number {
  return sample.fastCharger
    ? 0
    : (sample.volts * sample.amps * sample.phases) / 1000;
}

function round(kwh: number): number {
  return Math.round(kwh * 100) / 100;
}

/** Golem's signing key, which it makes once; the cars take only commands that it signed. */
function signingKey(directory: string): string {
  const file = join(directory, "tesla", "private-key.pem");
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    writeFileSync(
      file,
      (privateKey as KeyObject).export({ type: "sec1", format: "pem" }),
      {
        mode: 0o600,
      }
    );
  }
  return file;
}

/** Runs tesla-control; it reads the token from a file, which only Golem's user can read, and which Golem removes. */
function spawner(
  binary: string,
  keyFile: string
): NonNullable<TeslaOptions["run"]> {
  return async (command, signal) => {
    const tokenAt = command.indexOf("-token");
    const token = command[tokenAt + 1]!;
    const directory = mkdtempSync(join(tmpdir(), "golem-tesla-"));
    try {
      const tokenFile = join(directory, "token");
      writeFileSync(tokenFile, token, { mode: 0o600 });
      const process = Bun.spawn(
        [
          binary,
          "-key-file",
          keyFile,
          "-token-file",
          tokenFile,
          "-connect-timeout",
          "30s",
          "-command-timeout",
          "20s",
          ...command.toSpliced(tokenAt, 2),
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: COMMAND_MS,
          ...(signal ? { signal } : {}),
        }
      );
      const [errors, code] = await Promise.all([
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (code !== 0) {
        throw new Error(
          errors.trim().replace(/^Error: /, "") ||
            `tesla-control exited with ${code}`
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function needed<Value>(value: Value | undefined, name: string): Value {
  if (value === undefined) {
    throw new Error(`This command needs \`${name}\`.`);
  }
  return value;
}

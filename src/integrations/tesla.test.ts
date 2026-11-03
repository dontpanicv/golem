import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CarLog,
  type Charge,
  chargeStep,
  regionOf,
  type Sample,
  teslaConnector,
} from "./tesla.ts";

const EU = "https://fleet-api.prd.eu.vn.cloud.tesla.com";
/** An access token of an account in Europe, as Tesla gives it: its audiences name the Fleet API of each region. */
const TOKEN = `x.${Buffer.from(
  JSON.stringify({
    aud: ["https://fleet-api.prd.na.vn.cloud.tesla.com", EU],
    ou_code: "EU",
  })
).toString("base64url")}.x`;
const VIN = "LRW3E7FS0RC000001";

function tesla(answer: (url: URL, init: RequestInit) => Response) {
  const directory = mkdtempSync(join(tmpdir(), "golem-tesla-test-"));
  const store = join(directory, "credential-1");
  const calls: URL[] = [];
  const commands: (readonly string[])[] = [];
  const connector = teslaConnector({
    binary: "tesla-control",
    directory,
    domain: "golem.example.com",
    request: (async (url: string | URL, init: RequestInit) => {
      calls.push(new URL(url));
      return answer(new URL(url), init);
    }) as unknown as typeof fetch,
    run: async (command) => {
      commands.push(command);
    },
    pause: async () => undefined,
  });
  const secret = JSON.stringify({ store, secret: TOKEN });
  return {
    connector,
    directory,
    store,
    calls,
    commands,
    run: (name: string, args: object) =>
      connector.tools
        .find((tool) => tool.name === name)!
        .execute(args, secret, undefined),
  };
}

test("the token's region names the Fleet API", () => {
  expect(regionOf(TOKEN)).toBe(EU);
  expect(() => regionOf("x.e30.x")).toThrow("Connect Tesla again");
});

test("a car that sleeps gives its state without waking; an online one gives its data in km", async () => {
  let state = "asleep";
  const { run, calls } = tesla((url) =>
    Response.json({
      response: url.pathname.endsWith("/vehicle_data")
        ? {
            vin: VIN,
            display_name: "Otloukanek",
            state,
            charge_state: {
              battery_level: 70,
              battery_range: 200,
              charging_state: "Charging",
              charge_energy_added: 12.5,
            },
            climate_state: { is_climate_on: true, inside_temp: 19.5 },
            vehicle_state: {
              locked: true,
              odometer: 10_000,
              df: 0,
              pf: 1,
              rt: 0,
            },
          }
        : [{ vin: VIN, display_name: "Otloukanek", state }],
    })
  );
  expect(await run("tesla_vehicle", {})).toEqual({
    vin: VIN,
    name: "Otloukanek",
    state: "asleep",
    lastSeen: null,
  });
  expect(calls.map((url) => url.pathname)).toEqual(["/api/1/vehicles"]);
  expect(calls[0]!.origin).toBe(EU);

  state = "online";
  const data = (await run("tesla_vehicle", {})) as {
    battery: object;
    charging: object;
    climate: object;
    vehicle: object;
  };
  expect(data.battery).toEqual({
    level: 70,
    rangeKm: 321.9,
    chargeLimit: null,
  });
  expect(data.charging).toMatchObject({
    state: "Charging",
    energyAddedKwh: 12.5,
  });
  expect(data.climate).toMatchObject({ on: true, insideCelsius: 19.5 });
  expect(data.vehicle).toMatchObject({
    locked: true,
    odometerKm: 16_093.4,
    openDoors: ["pf"],
    openTrunks: [],
  });
  expect(calls.at(-1)!.searchParams.get("endpoints")).toBe(
    "charge_state;climate_state;drive_state;location_data;vehicle_state"
  );
});

test("a command wakes a sleeping car, then tesla-control signs it", async () => {
  const states = ["asleep", "asleep", "online"];
  const { run, calls, commands, store } = tesla((url) =>
    Response.json({
      response: url.pathname.endsWith("/wake_up")
        ? { state: "asleep" }
        : { vin: VIN, state: states.shift() },
    })
  );
  expect(
    await run("tesla_command", {
      command: "set_temperature",
      vin: VIN,
      celsius: 21,
    })
  ).toEqual({ done: true, vin: VIN });
  expect(calls.map((url) => url.pathname)).toEqual([
    `/api/1/vehicles/${VIN}`,
    `/api/1/vehicles/${VIN}/wake_up`,
    `/api/1/vehicles/${VIN}`,
    `/api/1/vehicles/${VIN}`,
  ]);
  expect(commands).toEqual([
    [
      "-vin",
      VIN,
      "-session-cache",
      join(store, "sessions.json"),
      "-token",
      TOKEN,
      "climate-set-temp",
      "21c",
    ],
  ]);
  await expect(
    run("tesla_command", { command: "charge_limit", vin: VIN })
  ).rejects.toThrow("This command needs `percent`.");
});

test("opening the car asks the person first", async () => {
  const { connector } = tesla(() => Response.json({}));
  const open = connector.tools.find((tool) => tool.name === "tesla_open")!;
  expect(await open.approval!({ action: "unlock" }, "", undefined)).toBe(
    "Unlock the Tesla"
  );
  expect(
    await open.approval!({ action: "open_frunk", vin: VIN }, "", undefined)
  ).toBe(`Open the frunk of the Tesla ${VIN}`);
});

test("the client registers Golem's domain in each region, and Golem serves its public key", async () => {
  const bodies: string[] = [];
  const { connector, directory } = tesla((url, init) => {
    bodies.push(String(init.body));
    return url.pathname.endsWith("/token")
      ? Response.json({ access_token: "partner" })
      : Response.json({ response: {} });
  });
  const secret = "ta-secret.a+b&c=d%e#f g$!*";
  await connector.registerClient!({ clientId: "app", clientSecret: secret });
  const token = new URLSearchParams(bodies[0]);
  expect(token.get("grant_type")).toBe("client_credentials");
  expect(token.get("client_secret")).toBe(secret);
  expect(token.get("audience")).toBe(EU);
  expect(bodies[1]).toBe(JSON.stringify({ domain: "golem.example.com" }));
  expect(bodies).toHaveLength(4);

  const key = connector.publicKey!();
  expect(key).toStartWith("-----BEGIN PUBLIC KEY-----");
  // Golem makes the key once.
  expect(
    readFileSync(join(directory, "tesla", "private-key.pem"), "utf8")
  ).toStartWith("-----BEGIN EC PRIVATE KEY-----");
  expect(tesla(() => Response.json({})).connector.publicKey!()).not.toBe(key);

  const refused = tesla(() =>
    Response.json(
      {
        error: "unauthorized_client",
        error_description: "Client is not allowed this grant.",
      },
      { status: 401 }
    )
  );
  await expect(
    refused.connector.registerClient!({ clientId: "app", clientSecret: "no" })
  ).rejects.toThrow(
    "Tesla refused the client ID and secret (401, unauthorized_client): Client is not allowed this grant."
  );
});

/** A look at a car that charges from a household socket: 230 V, 10 A, one phase, 2 kW as the car rounds it. */
function socket(
  minutes: number,
  energyAdded: number,
  state = "Charging"
): Sample {
  return {
    time: Date.parse("2026-10-31T10:00:00Z") + minutes * 60_000,
    state,
    batteryLevel: 40 + Math.round(energyAdded),
    energyAdded,
    volts: state === "Charging" ? 230 : 0,
    amps: state === "Charging" ? 10 : 0,
    phases: 1,
    fastCharger: false,
    latitude: 49.2,
    longitude: 16.6,
  };
}

function steps(samples: (Sample | null)[], from: CarLog = {}) {
  const charges: Charge[] = [];
  let car = from;
  for (const sample of samples) {
    const step = chargeStep(car, sample);
    ({ car } = step);
    if (step.charge) {
      charges.push(step.charge);
    }
  }
  return { car, charges };
}

test("a charge session counts the kWh into the battery, and the kWh from the wall at the ratio that it saw", () => {
  // The log first sees the car 30 minutes into the charge, after 1 kWh, and sees 2 kWh more in 60 minutes.
  const { car, charges } = steps([
    socket(30, 1),
    socket(60, 2),
    socket(90, 3),
    socket(120, 3.2, "Complete"),
  ]);
  expect(charges).toEqual([
    {
      start: "2026-10-31T10:30:00.000Z",
      end: "2026-10-31T12:00:00.000Z",
      latitude: 49.2,
      longitude: 16.6,
      startBatteryLevel: 41,
      endBatteryLevel: 43,
      batteryKwh: 3.2,
      // 2.3 kWh from the wall for 2 kWh into the battery, so 3.68 for 3.2.
      wallKwh: 3.68,
      volts: 230,
      amps: 10,
      phases: 1,
      fastCharger: false,
    },
  ]);
  expect(car.session).toBeUndefined();

  // The cable stays in, and the car charges again: it counts on from 3.2 kWh.
  const again = steps([socket(300, 3.5), socket(330, 4.5), null], car);
  expect(again.charges[0]).toMatchObject({ batteryKwh: 1.3, wallKwh: 1.49 });

  // After the cable was out, the car counts from zero.
  const unplugged = steps(
    [socket(400, 0, "Disconnected"), socket(500, 5), socket(530, 6), null],
    again.car
  );
  expect(unplugged.charges[0]).toMatchObject({ batteryKwh: 6 });
});

test("a session at a fast charger has no kWh from the wall", () => {
  const fast = (minutes: number, energyAdded: number, state = "Charging") => ({
    ...socket(minutes, energyAdded, state),
    volts: 2,
    amps: 0,
    fastCharger: true,
  });
  const { charges } = steps([
    fast(0, 1),
    fast(5, 10),
    fast(10, 20, "Complete"),
  ]);
  expect(charges[0]).toMatchObject({
    batteryKwh: 20,
    wallKwh: null,
    fastCharger: true,
  });
});

test("the charge log keeps what it sees, and gives the session that goes on", async () => {
  const { connector, store, run } = tesla((url) =>
    Response.json({
      response: url.pathname.endsWith("/vehicle_data")
        ? {
            vin: VIN,
            state: "online",
            charge_state: {
              charging_state: "Charging",
              battery_level: 50,
              charge_energy_added: 4,
              charger_voltage: 230,
              charger_actual_current: 10,
              charger_power: 2,
              charger_phases: 1,
            },
            drive_state: { latitude: 49.2, longitude: 16.6 },
          }
        : [{ vin: VIN, state: "online" }],
    })
  );
  let looked: () => void = () => undefined;
  const lookedOnce = new Promise<void>((resolve) => {
    looked = resolve;
  });
  connector.keeper!.keep(store, async () => {
    setTimeout(looked, 50);
    return TOKEN;
  });
  await lookedOnce;
  connector.keeper!.close();
  expect(await run("tesla_charges", {})).toEqual([
    expect.objectContaining({
      vin: VIN,
      ongoing: true,
      batteryKwh: 4,
      startBatteryLevel: 50,
      volts: 230,
      phases: 1,
    }),
  ]);
  expect(await run("tesla_charges", { to: "2020-01-01T00:00:00Z" })).toEqual(
    []
  );
});

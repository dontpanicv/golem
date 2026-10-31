import { expect, test } from "bun:test";
import { netatmoConnector } from "./netatmo.ts";

function netatmo(answer: (url: URL) => Response) {
  const calls: { url: URL; authorization: string | null }[] = [];
  const request = (async (url: string, init: RequestInit) => {
    calls.push({
      url: new URL(url),
      authorization: new Headers(init.headers).get("authorization"),
    });
    return answer(new URL(url));
  }) as unknown as typeof fetch;
  const { tools } = netatmoConnector(request);
  return {
    calls,
    run: (name: string, args: object) =>
      tools
        .find((tool) => tool.name === name)!
        .execute(args, "access-1", undefined),
  };
}

test("stations give each module's values, with times in ISO 8601", async () => {
  const { run, calls } = netatmo(() =>
    Response.json({
      status: "ok",
      body: {
        devices: [
          {
            _id: "70:ee:50:00:00:01",
            station_name: "Home",
            module_name: "Indoor",
            type: "NAMain",
            reachable: true,
            dashboard_data: {
              time_utc: 1_761_900_000,
              Temperature: 21.4,
              CO2: 640,
            },
            modules: [
              {
                _id: "02:00:00:00:00:01",
                module_name: "Outdoor",
                type: "NAModule1",
                reachable: true,
                battery_percent: 80,
                dashboard_data: {
                  Temperature: 6.2,
                  date_min_temp: 1_761_880_000,
                },
              },
            ],
          },
        ],
      },
    })
  );
  expect(await run("netatmo_stations", {})).toEqual([
    {
      id: "70:ee:50:00:00:01",
      name: "Home",
      modules: [
        {
          id: "70:ee:50:00:00:01",
          name: "Indoor",
          type: "NAMain",
          reachable: true,
          batteryPercent: null,
          values: {
            time_utc: "2025-10-31T08:40:00.000Z",
            Temperature: 21.4,
            CO2: 640,
          },
        },
        {
          id: "02:00:00:00:00:01",
          name: "Outdoor",
          type: "NAModule1",
          reachable: true,
          batteryPercent: 80,
          values: {
            Temperature: 6.2,
            date_min_temp: "2025-10-31T03:06:40.000Z",
          },
        },
      ],
    },
  ]);
  expect(calls[0]!.authorization).toBe("Bearer access-1");
  expect(calls[0]!.url.pathname).toBe("/api/getstationsdata");
});

test("a measure gives one value for each type at each time", async () => {
  const { run, calls } = netatmo(() =>
    Response.json({
      status: "ok",
      body: { "1761868800": [5.1, 90], "1761872400": [4.8, null] },
    })
  );
  expect(
    await run("netatmo_measure", {
      station: "70:ee:50:00:00:01",
      module: "02:00:00:00:00:01",
      types: ["temperature", "humidity"],
      scale: "1hour",
      start: "2025-10-31T00:00:00Z",
    })
  ).toEqual([
    {
      time: "2025-10-31T00:00:00.000Z",
      temperature: 5.1,
      humidity: 90,
    },
    {
      time: "2025-10-31T01:00:00.000Z",
      temperature: 4.8,
      humidity: null,
    },
  ]);
  expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({
    device_id: "70:ee:50:00:00:01",
    module_id: "02:00:00:00:00:01",
    type: "temperature,humidity",
    scale: "1hour",
    date_begin: "1761868800",
  });
});

test("an error of Netatmo reaches the agent with its message", async () => {
  const { run } = netatmo(() =>
    Response.json(
      { error: { code: 3, message: "Access token expired" } },
      { status: 403 }
    )
  );
  await expect(run("netatmo_stations", {})).rejects.toThrow(
    "Netatmo answered 403: Access token expired"
  );
});

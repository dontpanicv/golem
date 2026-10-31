import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { salusConnector, thermostatStatus } from "./salus.ts";

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

/** Salus's cloud: it takes the password `secret1` and gives `token-<n>` for the nth session. */
function salus(answer: (call: string, query: URLSearchParams) => Response) {
  const calls: string[] = [];
  let sessions = 0;
  const request = (async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/sessions")) {
      const { password } = JSON.parse(String(init!.body)) as {
        password: string;
      };
      calls.push(`sign-in ${password}`);
      if (password !== md5("secret1")) {
        return new Response("", { status: 401 });
      }
      sessions += 1;
      return Response.json({ userId: 7, securityToken: `token-${sessions}` });
    }
    const call = pathname.split("/").at(-1)!;
    // Calls that read send a form; a change sends a query.
    const values = init?.body
      ? new URLSearchParams(String(init.body))
      : searchParams;
    calls.push(`${init?.method ?? "GET"} ${call} ${values.get("secToken")}`);
    return answer(call, values);
  }) as unknown as typeof fetch;
  const connector = salusConnector(request);
  return {
    calls,
    connector,
    run: (name: string, args: object, secret: string) =>
      connector.tools
        .find((tool) => tool.name === name)!
        .execute(args, secret, undefined),
  };
}

const ATTRIBUTES = `<ns1:getDeviceAttributesWithValuesResponse>
<devId>50339139</devId><presenceInfo>1</presenceInfo>
<attrList><id>1</id><name>desc</name><value>Chata &amp; garage</value><updTime>1761900000000</updTime></attrList>
<attrList><id>2</id><name>A84</name><value>1850</value><updTime>1761900600000</updTime></attrList>
<attrList><id>3</id><name>A85</name><value>2150</value><updTime>1761900000000</updTime></attrList>
<attrList><id>4</id><name>A87</name><value>1</value><updTime>1761900000000</updTime></attrList>
<attrList><id>5</id><name>A88</name><value>1</value><updTime>1761900000000</updTime></attrList>
<attrList><id>6</id><name>A89</name><value>0</value><updTime>1761900000000</updTime></attrList>
<attrList><id>7</id><name>A92</name><value>0</value><updTime>1761900000000</updTime></attrList>
</ns1:getDeviceAttributesWithValuesResponse>`;

test("adding a credential signs in, also with a password whose special characters Salus removed", async () => {
  const { connector, calls } = salus(() => new Response(""));
  const added = await connector.secretFrom!(
    JSON.stringify({ username: "anna@example.com", secret: "secret1!" })
  );
  expect(added.label).toBe("anna@example.com");
  expect(JSON.parse(added.secret)).toEqual({
    email: "anna@example.com",
    hash: md5("secret1"),
  });
  expect(calls).toEqual([
    `sign-in ${md5("secret1!")}`,
    `sign-in ${md5("secret1")}`,
  ]);
  await expect(
    connector.secretFrom!(
      JSON.stringify({ username: "anna@example.com", secret: "wrong" })
    )
  ).rejects.toThrow("Salus refused the email or password");
});

test("a status reads the first heating zone", () => {
  expect(thermostatStatus(ATTRIBUTES)).toEqual({
    name: "Chata & garage",
    roomTemperature: 18.5,
    targetTemperature: 21.5,
    heating: true,
    mode: "temporary_hold",
    connected: true,
    reportedAt: "2025-10-31T08:50:00.000Z",
  });
});

test("the tools keep one session, and sign in again when Salus ends it", async () => {
  let expired = false;
  const { run, calls } = salus((call, query) => {
    if (expired && query.get("secToken") === "token-1") {
      return new Response("<errorCode>106</errorCode>", { status: 500 });
    }
    if (call === "getDeviceList") {
      return new Response(
        "<ns1:getDeviceListResponse><devList><devId>50339139</devId><devName>Chata</devName></devList></ns1:getDeviceListResponse>"
      );
    }
    return new Response(
      query.get("value1") === "2200"
        ? "<retCode>0</retCode>"
        : "<retCode>-1</retCode>"
    );
  });
  const secret = JSON.stringify({ email: "a@b.c", hash: md5("secret1") });
  expect(await run("salus_thermostats", {}, secret)).toEqual([
    { id: "50339139", name: "Chata" },
  ]);
  expired = true;
  expect(
    await run(
      "salus_set_temperature",
      { thermostat: "50339139", temperature: 22 },
      secret
    )
  ).toEqual({ thermostat: "50339139", targetTemperature: 22 });
  expect(calls).toEqual([
    `sign-in ${md5("secret1")}`,
    "POST getDeviceList token-1",
    "GET setMultiDeviceAttributes2 token-1",
    `sign-in ${md5("secret1")}`,
    "GET setMultiDeviceAttributes2 token-2",
  ]);
  await expect(
    run(
      "salus_set_temperature",
      { thermostat: "50339139", temperature: 23 },
      secret
    )
  ).rejects.toThrow("Salus refused the temperature (code -1)");
  await expect(
    run(
      "salus_set_temperature",
      { thermostat: "50339139", temperature: 21.3 },
      secret
    )
  ).rejects.toThrow("from 5 to 34.5 °C");
});

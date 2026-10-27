import { describe, expect, test } from "bun:test";
import { homeAssistantConnector } from "./home-assistant.ts";

const SECRET = JSON.stringify({
  address: "http://home.local:8123/",
  secret: "token-1",
});

function connector(answer: (url: string) => Response) {
  const calls: {
    url: string;
    method: string;
    authorization: string | null;
    body: unknown;
  }[] = [];
  const request = (async (url: URL, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method!,
      authorization: new Headers(init.headers).get("authorization"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return answer(String(url));
  }) as unknown as typeof fetch;
  const { tools } = homeAssistantConnector(request);
  return {
    calls,
    run: (name: string, args: object, secret = SECRET) =>
      tools
        .find((tool) => tool.name === name)!
        .execute(args, secret, undefined),
  };
}

function entity(entity_id: string, state: string) {
  return {
    entity_id,
    state,
    attributes: {},
    last_changed: "2026-10-27T08:00:00Z",
    last_updated: "2026-10-27T08:00:00Z",
    context: { id: "1" },
  };
}

describe("homeAssistantConnector", () => {
  test("gives the states of a domain, with the token, without their context", async () => {
    const { calls, run } = connector(() =>
      Response.json([
        entity("light.desk", "on"),
        entity("climate.bedroom", "heat"),
      ])
    );
    expect(await run("home_assistant_states", { domain: "light" })).toEqual([
      {
        entity_id: "light.desk",
        state: "on",
        attributes: {},
        last_changed: "2026-10-27T08:00:00Z",
        last_updated: "2026-10-27T08:00:00Z",
      },
    ]);
    expect(calls).toEqual([
      {
        url: "http://home.local:8123/api/states",
        method: "GET",
        authorization: "Bearer token-1",
        body: undefined,
      },
    ]);
  });

  test("calls a service with its data, and never one that sends", async () => {
    const { calls, run } = connector(() =>
      Response.json([entity("light.desk", "off")])
    );
    await run("home_assistant_call", {
      domain: "light",
      service: "turn_off",
      data: { area_id: "bedroom" },
    });
    expect(calls[0]).toMatchObject({
      url: "http://home.local:8123/api/services/light/turn_off",
      method: "POST",
      body: { area_id: "bedroom" },
    });
    await expect(
      run("home_assistant_call", { domain: "notify", service: "family" })
    ).rejects.toThrow("Agents do not send");
    expect(calls).toHaveLength(1);
  });

  test("renders a template as text, and asks for history of entities", async () => {
    const { calls, run } = connector((url) =>
      url.endsWith("/template")
        ? new Response("['light.desk']")
        : Response.json([[]])
    );
    expect(
      await run("home_assistant_template", {
        template: "{{ area_entities('Bedroom') }}",
      })
    ).toBe("['light.desk']");
    await run("home_assistant_history", {
      entity_ids: ["sensor.a", "sensor.b"],
      start: "2026-10-26T00:00:00Z",
    });
    expect(calls[1]!.url).toBe(
      "http://home.local:8123/api/history/period/2026-10-26T00%3A00%3A00Z?filter_entity_id=sensor.a%2Csensor.b&minimal_response&no_attributes"
    );
  });

  test("says what to do when the token is wrong", async () => {
    const { run } = connector(() => new Response("", { status: 401 }));
    await expect(run("home_assistant_states", {})).rejects.toThrow(
      "refused the access token"
    );
  });
});

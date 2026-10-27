import { Type } from "@earendil-works/pi-ai";
import type { Connector } from "./integrations.ts";

/** How long one call to Home Assistant may take. */
const TIMEOUT_MS = 30 * 1000;
/** Services that send messages; agents never send them. */
const SENDS = new Set(["notify"]);

/** An entity's state as the tools give it, without Home Assistant's `context`. */
export interface EntityState {
  readonly entity_id: string;
  readonly state: string;
  readonly attributes: Record<string, unknown>;
  readonly last_changed: string;
  readonly last_updated: string;
}

/**
 * The home's Home Assistant through its REST API (https://developers.home-assistant.io/docs/api/rest), with a
 * long-lived access token of a Home Assistant user, at the address of the home's own server. Golem calls that address
 * itself, also on a private network, because a person, not an agent, gave it. Templates need an administrator.
 */
export function homeAssistantConnector(
  request: typeof fetch = fetch
): Connector {
  async function call<Result>(
    secret: string,
    path: string,
    signal: AbortSignal | undefined,
    body?: unknown
  ): Promise<Result> {
    const { address, secret: token } = JSON.parse(secret) as {
      address: string;
      secret: string;
    };
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await request(
      new URL(`api/${path}`, address.endsWith("/") ? address : `${address}/`),
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }
    );
    if (response.status === 401) {
      throw new Error(
        "Home Assistant refused the access token; connect Home Assistant again with a new one"
      );
    }
    if (!response.ok) {
      throw new Error(
        `Home Assistant answered ${response.status}: ${(await response.text()).slice(0, 500)}`
      );
    }
    return (
      response.headers.get("content-type")?.includes("json")
        ? await response.json()
        : await response.text()
    ) as Result;
  }

  return {
    id: "home_assistant",
    name: "Home Assistant",
    description:
      "The home's Home Assistant: the state and history of its lights, heating, devices, and sensors, and the services that control them.",
    secretLabel: "Long-lived access token",
    guide: [
      "In Home Assistant, open the profile of an administrator › **Security** › **Long-lived access tokens**, click **Create token**, and copy it.",
      "Click **Add credential**. Type the name of the home as the label, the address of Home Assistant, such as `http://homeassistant.local:8123`, and paste the token.",
      "The Golem machine must reach that address, for example over your VPN.",
    ],
    address: true,
    tools: [
      {
        name: "home_assistant_states",
        description:
          "The current state and attributes of entities, such as `climate.bedroom_heating`. All entities when neither filter is given.",
        parameters: Type.Object({
          domain: Type.Optional(
            Type.String({
              description: "Only entities of this domain, such as `light`.",
            })
          ),
          entity_ids: Type.Optional(Type.Array(Type.String())),
        }),
        execute: async ({ domain, entity_ids }, secret, signal) =>
          (
            await call<(EntityState & { context?: unknown })[]>(
              secret,
              "states",
              signal
            )
          )
            .filter(
              (entity) =>
                (!domain || entity.entity_id.startsWith(`${domain}.`)) &&
                (!entity_ids || entity_ids.includes(entity.entity_id))
            )
            .map(({ context: _, ...entity }) => entity),
      },
      {
        name: "home_assistant_services",
        description:
          "The services that home_assistant_call can call, with their fields, by domain.",
        parameters: Type.Object({
          domain: Type.Optional(
            Type.String({ description: "Only this domain, such as `climate`." })
          ),
        }),
        execute: async ({ domain }, secret, signal) =>
          (
            await call<{ domain: string; services: object }[]>(
              secret,
              "services",
              signal
            )
          ).filter((entry) => !domain || entry.domain === domain),
      },
      {
        name: "home_assistant_call",
        description:
          "Calls a service, such as `light.turn_on` or `climate.set_temperature`, and gives the states that it changed. Put the targets, such as `entity_id` or `area_id`, in `data`. Services of `notify` are not possible.",
        parameters: Type.Object({
          domain: Type.String(),
          service: Type.String(),
          data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          return_response: Type.Optional(
            Type.Boolean({
              description:
                "For services that give a response, such as `weather.get_forecasts`.",
            })
          ),
        }),
        execute: async (
          { domain, service, data, return_response },
          secret,
          signal
        ) => {
          if (SENDS.has(domain)) {
            throw new Error(
              "Agents do not send messages through Home Assistant."
            );
          }
          return call(
            secret,
            `services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}${return_response ? "?return_response" : ""}`,
            signal,
            data ?? {}
          );
        },
      },
      {
        name: "home_assistant_template",
        description:
          "Renders a Home Assistant template, such as `{{ area_entities('Bedroom') }}` or `{{ states.sensor | selectattr('attributes.device_class', 'eq', 'temperature') | map(attribute='entity_id') | list }}`. Use it for areas, devices, and questions across entities.",
        parameters: Type.Object({ template: Type.String() }),
        execute: async ({ template }, secret, signal) =>
          call<string>(secret, "template", signal, { template }),
      },
      {
        name: "home_assistant_history",
        description:
          "The states of entities from `start` until `end` or now, oldest first, one list for each entity.",
        parameters: Type.Object({
          entity_ids: Type.Array(Type.String(), { minItems: 1 }),
          start: Type.String({ description: "An ISO 8601 time." }),
          end: Type.Optional(Type.String({ description: "An ISO 8601 time." })),
        }),
        execute: async ({ entity_ids, start, end }, secret, signal) =>
          call(
            secret,
            `history/period/${encodeURIComponent(start)}?${new URLSearchParams({
              filter_entity_id: entity_ids.join(","),
              ...(end ? { end_time: end } : {}),
            })}&minimal_response&no_attributes`,
            signal
          ),
      },
    ],
  };
}

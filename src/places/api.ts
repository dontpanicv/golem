import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError, required } from "../platform/errors.ts";

/** The OpenStreetMap tiles, which the web app's map shows through Golem, because its page loads pictures only from Golem. */
const TILES = "https://tile.openstreetmap.org";
const MAX_ZOOM = 19;
/** OpenStreetMap's search, which finds the address that a person types in the web app's place dialog. */
const SEARCH = "https://nominatim.openstreetmap.org/search";
/** OpenStreetMap's tile and search policies ask for a User-Agent that names the app. */
const USER_AGENT = "Golem (self-hosted family assistant)";

/** The places that a person sees in the workspace, their own and the shared ones, which they add, change, or remove. */
export const placeApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/workspaces/:workspace/places",
    api(async ({ app, user, params }) =>
      json({ places: app.places.list(params.workspace!, user) })
    ),
  ],
  [
    "POST",
    "/api/v1/workspaces/:workspace/places",
    api(async ({ app, user, params, body }) =>
      json(app.places.create(params.workspace!, user, body), 201)
    ),
  ],
  [
    "PUT",
    "/api/v1/workspaces/:workspace/places/:place",
    api(async ({ app, user, params, body }) =>
      json(app.places.update(params.workspace!, user, params.place!, body))
    ),
  ],
  [
    "DELETE",
    "/api/v1/workspaces/:workspace/places/:place",
    api(async ({ app, user, params }) => {
      app.places.remove(params.workspace!, user, params.place!);
      return new Response(null, { status: 204 });
    }),
  ],
  [
    "GET",
    "/api/v1/map/search",
    api(async ({ request }) => {
      const url = new URL(request.url);
      const query = required(url.searchParams.get("q"), "Address");
      const found = await fetch(
        `${SEARCH}?${new URLSearchParams({ q: query, format: "jsonv2", limit: "1" })}`,
        {
          headers: {
            "user-agent": USER_AGENT,
            "accept-language": request.headers.get("accept-language") ?? "en",
          },
        }
      );
      if (!found.ok) {
        throw new HttpError(502, "The address search is not available");
      }
      const [first] = (await found.json()) as {
        lat: string;
        lon: string;
        display_name: string;
      }[];
      if (!first) {
        throw new HttpError(404, "Golem did not find this address");
      }
      return json({
        latitude: Number(first.lat),
        longitude: Number(first.lon),
        label: first.display_name,
      });
    }),
  ],
  [
    "GET",
    "/api/v1/map/:zoom/:x/:y",
    api(async ({ params }) => {
      const [zoom, x, y] = [params.zoom, params.x, params.y].map(Number);
      const size = 2 ** zoom!;
      if (
        ![zoom, x, y].every(Number.isInteger) ||
        zoom! < 0 ||
        zoom! > MAX_ZOOM ||
        x! < 0 ||
        y! < 0 ||
        x! >= size ||
        y! >= size
      ) {
        throw new HttpError(404, "Not found");
      }
      const tile = await fetch(`${TILES}/${zoom}/${x}/${y}.png`, {
        headers: { "user-agent": USER_AGENT },
      });
      if (!tile.ok) {
        throw new HttpError(502, "The map is not available");
      }
      return new Response(tile.body, {
        headers: {
          "content-type": "image/png",
          "cache-control": "private, max-age=604800",
        },
      });
    }),
  ],
];

import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";
import { HttpError } from "../platform/errors.ts";

/** The OpenStreetMap tiles, which the web app's map shows through Golem, because its page loads pictures only from Golem. */
const TILES = "https://tile.openstreetmap.org";
const MAX_ZOOM = 19;

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
      // OpenStreetMap's tile policy asks for a User-Agent that names the app.
      const tile = await fetch(`${TILES}/${zoom}/${x}/${y}.png`, {
        headers: { "user-agent": "Golem (self-hosted family assistant)" },
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

import type { Database } from "bun:sqlite";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";

/** A place that a person marked on a map, which a reminder or a routine waits for. */
export interface Place {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  /** The radius of its circle, in meters. */
  readonly radius: number;
  /** The person who added it; only they change or remove it. */
  readonly ownerId: string;
  readonly ownerName: string;
  /** Whether every member's turns use it; else only its owner's. */
  readonly shared: boolean;
}

/** A person arrives at a place, or leaves it. */
export type PlaceEvent = "arrive" | "leave";

/**
 * What a person's iPhone saw at a place: a crossing, or the first state after it starts to watch the place (`initial`),
 * when the person did not cross the circle.
 */
export interface PlaceReport {
  readonly event: PlaceEvent;
  /** When it happened; a report that waited for a connection comes late. */
  readonly at: number;
  readonly initial: boolean;
}

export type PlaceInput = Pick<
  Place,
  "name" | "latitude" | "longitude" | "radius" | "shared"
>;

/** One specific place on OpenStreetMap, such as one shop, or an address that the map search finds. */
export interface PointOfInterest {
  /** OpenStreetMap's id, such as W258949900. */
  readonly osmId: string;
  /** The name with its street and town, which tells it from others of the same name. */
  readonly name: string;
  /** OpenStreetMap's category and type, such as shop/furniture. */
  readonly kind: string;
  readonly address: string;
  readonly latitude: number;
  readonly longitude: number;
  /** The radius of its circle, in meters. */
  readonly radius: number;
}

/** The smallest and largest radius in meters: iOS does not see a smaller circle reliably. */
export const MIN_RADIUS = 100;
export const MAX_RADIUS = 5000;
/** OpenStreetMap's tile and search policies ask for a User-Agent that names the app. */
export const USER_AGENT = "Golem (self-hosted family assistant)";

/** OpenStreetMap's search. Its policy allows one request each second, and no autocomplete. */
const NOMINATIM = "https://nominatim.openstreetmap.org";
const NOMINATIM_SPACING = 1100;
const NOMINATIM_TIMEOUT = 10_000;
const POINT_OF_INTEREST_RESULTS = 5;
/** The smallest circle of a point of interest, for a shop that OpenStreetMap has as one point. */
const POINT_OF_INTEREST_RADIUS = 150;
const METERS_PER_DEGREE = 111_320;

type PlaceWorkspaces = Pick<Workspaces, "members" | "requireMember">;

const FIELDS =
  "id, name, latitude, longitude, radius, owner_id AS ownerId, shared";
/** The places that a person's turns in a workspace use: the shared ones and their own, without points of interest. */
const SEEN_BY =
  "workspace_id = $workspaceId AND deleted_at IS NULL AND osm_id IS NULL AND (shared = 1 OR owner_id = $userId)";
/** The live place of the person in the workspace, which they added in Settings. */
const OWN =
  "workspace_id = $workspaceId AND owner_id = $userId AND deleted_at IS NULL AND osm_id IS NULL AND id = $placeId";

/**
 * The places of each person in the workspace, which they add in their own Settings from a pin on a map. Like a
 * credential, a place is private to its owner's turns until they share it with every member's. A point of interest is
 * also a place, so that phones watch it the same way, but only its owner's reminders use it and Settings never shows it.
 */
export class Places {
  /** The end of the last request to OpenStreetMap's search, and the pause after it. */
  private nominatimTurn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly database: Database,
    private readonly workspaces: PlaceWorkspaces,
    private readonly request: typeof fetch = fetch
  ) {}

  /** What OpenStreetMap's search finds for an address or a name, best first. */
  async search(
    query: string,
    limit: number,
    language?: string
  ): Promise<PointOfInterest[]> {
    const rows = await this.nominatim(
      "search",
      { q: query, limit: String(limit) },
      language
    );
    return rows.map(pointOfInterestOf);
  }

  /** The specific places that OpenStreetMap's search finds for a person's reminder, without cities and other areas. */
  async searchPointsOfInterest(query: string): Promise<PointOfInterest[]> {
    return (await this.search(query, POINT_OF_INTEREST_RESULTS)).filter(
      (point) => point.osmId !== "" && !isArea(point.kind)
    );
  }

  /** Keeps a point of interest of OpenStreetMap as a place of `ownerId`, and reuses the place when they have it. */
  async savePointOfInterest(
    workspaceId: string,
    ownerId: string,
    osmId: string
  ): Promise<Place> {
    if (!/^[NWR]\d+$/.test(osmId)) {
      throw new HttpError(
        400,
        "Give an id from the search of points of interest"
      );
    }
    const [row] = await this.nominatim("lookup", { osm_ids: osmId });
    if (!row) {
      throw new HttpError(404, "OpenStreetMap does not have this place");
    }
    const point = pointOfInterestOf(row);
    if (isArea(point.kind)) {
      throw new HttpError(
        400,
        "A city or another area is not a specific place"
      );
    }
    const { id } = this.database
      .query(
        "INSERT INTO place (id, workspace_id, owner_id, name, latitude, longitude, radius, shared, created_at, osm_id) VALUES ($id, $workspaceId, $ownerId, $name, $latitude, $longitude, $radius, 0, $now, $osmId) ON CONFLICT (workspace_id, owner_id, osm_id) WHERE osm_id IS NOT NULL DO UPDATE SET name = $name, latitude = $latitude, longitude = $longitude, radius = $radius RETURNING id"
      )
      .get({
        id: Bun.randomUUIDv7(),
        workspaceId,
        ownerId,
        // A place's name ends at `~` when it reads the name of a removed place.
        name: point.name.replaceAll("~", " "),
        latitude: point.latitude,
        longitude: point.longitude,
        radius: point.radius,
        now: Date.now(),
        osmId,
      }) as { id: string };
    return this.find(workspaceId, id)!;
  }

  /** The ids of the points of interest of the person. */
  pointsOfInterestOf(workspaceId: string, ownerId: string): string[] {
    return (
      this.database
        .query(
          "SELECT id FROM place WHERE workspace_id = ? AND owner_id = ? AND osm_id IS NOT NULL AND deleted_at IS NULL"
        )
        .all(workspaceId, ownerId) as { id: string }[]
    ).map(({ id }) => id);
  }

  /** The places that the person sees: their own and the shared ones, by name. */
  list(workspaceId: string, user: User): Place[] {
    this.workspaces.requireMember(workspaceId, user);
    return this.usable(workspaceId, user.id);
  }

  /** The places that a turn of `userId` uses: their own first, then the shared ones, each by name. */
  usable(workspaceId: string, userId: string): Place[] {
    return this.withOwners(
      workspaceId,
      userId,
      this.database
        .query(
          `SELECT ${FIELDS} FROM place WHERE ${SEEN_BY} ORDER BY owner_id IS NOT $userId, name COLLATE NOCASE`
        )
        .all({ workspaceId, userId }) as PlaceRow[]
    );
  }

  /** A place by id, also a removed one: a reminder keeps the place it was made for. */
  find(workspaceId: string, placeId: string): Place | null {
    const row = this.database
      .query(`SELECT ${FIELDS} FROM place WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, placeId) as PlaceRow | null;
    return row ? this.withOwners(workspaceId, row.ownerId, [row])[0]! : null;
  }

  create(workspaceId: string, user: User, input: unknown): Place {
    this.workspaces.requireMember(workspaceId, user);
    const place = placeInput(input);
    const id = Bun.randomUUIDv7();
    this.requireFreeName(workspaceId, user.id, place.name, null);
    this.database
      .query(
        "INSERT INTO place (id, workspace_id, owner_id, name, latitude, longitude, radius, shared, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        workspaceId,
        user.id,
        place.name,
        place.latitude,
        place.longitude,
        place.radius,
        place.shared ? 1 : 0,
        Date.now()
      );
    return this.find(workspaceId, id)!;
  }

  /** Changes the person's own place: its name, pin, radius, and whether it is shared. */
  update(
    workspaceId: string,
    user: User,
    placeId: string,
    input: unknown
  ): Place {
    this.workspaces.requireMember(workspaceId, user);
    const place = placeInput(input);
    this.requireFreeName(workspaceId, user.id, place.name, placeId);
    const { changes } = this.database
      .query(
        `UPDATE place SET name = $name, latitude = $latitude, longitude = $longitude, radius = $radius, shared = $shared WHERE ${OWN}`
      )
      .run({
        ...place,
        shared: place.shared ? 1 : 0,
        workspaceId,
        userId: user.id,
        placeId,
      });
    if (changes === 0) {
      throw notFound();
    }
    return this.find(workspaceId, placeId)!;
  }

  /**
   * Keeps what the person's iPhone saw at a place as their last state there, and gives the state before it, or null
   * when there was none. Gives `stale` for a report older than the last one, which changes nothing.
   */
  record(
    placeId: string,
    personId: string,
    report: PlaceReport
  ): { readonly before: boolean | null } | "stale" {
    const last = this.database
      .query(
        "SELECT inside, at FROM place_presence WHERE place_id = ? AND person_id = ? AND watched = 1"
      )
      .get(placeId, personId) as { inside: number; at: number } | null;
    if (last && last.at > report.at) {
      return "stale";
    }
    this.database
      .query(
        "INSERT INTO place_presence (place_id, person_id, inside, at) VALUES ($placeId, $personId, $inside, $at) ON CONFLICT (place_id, person_id) DO UPDATE SET inside = $inside, at = $at, watched = 1"
      )
      .run({
        placeId,
        personId,
        inside: report.event === "arrive" ? 1 : 0,
        at: report.at,
      });
    return { before: last ? last.inside === 1 : null };
  }

  /** Whether the person was in the place when their phone last said; null when it never said, or stopped watching it. */
  inside(placeId: string, personId: string): boolean | null {
    const last = this.database
      .query(
        "SELECT inside FROM place_presence WHERE place_id = ? AND person_id = ? AND watched = 1"
      )
      .get(placeId, personId) as { inside: number } | null;
    return last ? last.inside === 1 : null;
  }

  /**
   * The person's phone watches only the places of `watched` from now on, and reports nothing from the others: their
   * last state there no longer counts, until the phone watches the place again and says.
   */
  unwatch(
    workspaceId: string,
    personId: string,
    watched: readonly string[]
  ): void {
    this.database
      .query(
        "UPDATE place_presence SET watched = 0 WHERE person_id = ? AND watched = 1 AND place_id IN (SELECT id FROM place WHERE workspace_id = ?) AND place_id NOT IN (SELECT value FROM json_each(?))"
      )
      .run(personId, workspaceId, JSON.stringify(watched));
  }

  /** Removes the person's own place; its name gets `~<id>`, so it is free again. */
  remove(workspaceId: string, user: User, placeId: string): void {
    this.workspaces.requireMember(workspaceId, user);
    const { changes } = this.database
      .query(
        `UPDATE place SET deleted_at = $now, name = name || '~' || id WHERE ${OWN}`
      )
      .run({ now: Date.now(), workspaceId, userId: user.id, placeId });
    if (changes === 0) {
      throw notFound();
    }
  }

  /** Asks OpenStreetMap's search, one request at a time, as its policy says. */
  private nominatim(
    path: "search" | "lookup",
    parameters: Record<string, string>,
    language?: string
  ): Promise<NominatimRow[]> {
    const answer = this.nominatimTurn.then(() =>
      this.askNominatim(path, parameters, language)
    );
    const pause = () => Bun.sleep(NOMINATIM_SPACING);
    this.nominatimTurn = answer.then(pause, pause);
    return answer;
  }

  private async askNominatim(
    path: "search" | "lookup",
    parameters: Record<string, string>,
    language?: string
  ): Promise<NominatimRow[]> {
    const found = await this.request(
      `${NOMINATIM}/${path}?${new URLSearchParams({ ...parameters, format: "jsonv2", addressdetails: "1" })}`,
      {
        headers: {
          "user-agent": USER_AGENT,
          ...(language ? { "accept-language": language } : {}),
        },
        signal: AbortSignal.timeout(NOMINATIM_TIMEOUT),
      }
    );
    if (!found.ok) {
      throw new HttpError(502, "The address search is not available");
    }
    return (await found.json()) as NominatimRow[];
  }

  private requireFreeName(
    workspaceId: string,
    userId: string,
    name: string,
    placeId: string | null
  ): void {
    const taken = this.database
      .query(
        "SELECT 1 FROM place WHERE workspace_id = ? AND owner_id = ? AND name = ? COLLATE NOCASE AND osm_id IS NULL AND id IS NOT ?"
      )
      .get(workspaceId, userId, name, placeId);
    if (taken) {
      throw new HttpError(409, "You already have a place with this name");
    }
  }

  /** The places with their owners' names, from the members that `memberId` sees. */
  private withOwners(
    workspaceId: string,
    memberId: string,
    rows: PlaceRow[]
  ): Place[] {
    if (rows.length === 0) {
      return [];
    }
    const names = new Map<string, string>();
    try {
      for (const member of this.workspaces.members(workspaceId, {
        id: memberId,
        name: "",
        email: "",
      })) {
        names.set(member.userId, member.name);
      }
    } catch {
      // The owner left the workspace; a reminder still keeps their place.
    }
    return rows.map((row) => ({
      ...row,
      // A removed place keeps its name for its reminders, without its `~<id>`.
      name: row.name.replace(/~[^~]*$/, ""),
      ownerName: names.get(row.ownerId) ?? "",
      shared: row.shared === 1,
    }));
  }
}

interface PlaceRow extends Omit<Place, "ownerName" | "shared"> {
  readonly shared: number;
}

/** A result of OpenStreetMap's search, in its `jsonv2` format. */
interface NominatimRow {
  readonly osm_type?: string;
  readonly osm_id?: number;
  readonly category: string;
  readonly type: string;
  readonly name: string;
  readonly display_name: string;
  readonly lat: string;
  readonly lon: string;
  /** South, north, west, and east. */
  readonly boundingbox: readonly string[];
  readonly address?: Readonly<Record<string, string>>;
}

function pointOfInterestOf(row: NominatimRow): PointOfInterest {
  const address = row.address ?? {};
  const street = [address.road, address.house_number].filter(Boolean).join(" ");
  const town = address.city ?? address.town ?? address.village;
  const latitude = Number(row.lat);
  return {
    osmId: row.osm_type ? `${row.osm_type[0]!.toUpperCase()}${row.osm_id}` : "",
    name:
      [row.name, street, town].filter(Boolean).join(", ") || row.display_name,
    kind: `${row.category}/${row.type}`,
    address: row.display_name,
    latitude,
    longitude: Number(row.lon),
    radius: circleRadius(row.boundingbox.map(Number), latitude),
  };
}

/** A radius that holds the place's map box: half of the box's diagonal. */
function circleRadius(box: readonly number[], latitude: number): number {
  const [south, north, west, east] = box as [number, number, number, number];
  const height = (north - south) * METERS_PER_DEGREE;
  const width =
    (east - west) * METERS_PER_DEGREE * Math.cos((latitude * Math.PI) / 180);
  return Math.min(
    MAX_RADIUS,
    Math.max(
      POINT_OF_INTEREST_RADIUS,
      Math.round(Math.hypot(height, width) / 2)
    )
  );
}

/** Whether OpenStreetMap's kind is a city, a district, or another area, which is not one specific place. */
function isArea(kind: string): boolean {
  return (
    kind.startsWith("boundary/") ||
    (kind.startsWith("place/") && kind !== "place/house")
  );
}

/** A place from a request body; throws a 400 that names what is wrong. */
function placeInput(input: unknown): PlaceInput {
  const body = (input ?? {}) as Record<string, unknown>;
  const { latitude, longitude, radius } = body;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    throw new HttpError(400, "Put the pin on the map");
  }
  if (
    typeof radius !== "number" ||
    !Number.isInteger(radius) ||
    radius < MIN_RADIUS ||
    radius > MAX_RADIUS
  ) {
    throw new HttpError(
      400,
      `The radius must be ${MIN_RADIUS} to ${MAX_RADIUS} meters`
    );
  }
  const name = required(body.name, "Name");
  if (name.includes("~")) {
    throw new HttpError(400, "A place name cannot contain ~");
  }
  return { name, latitude, longitude, radius, shared: body.shared === true };
}

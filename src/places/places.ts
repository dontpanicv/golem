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

/** The smallest and largest radius in meters: iOS does not see a smaller circle reliably. */
export const MIN_RADIUS = 100;
export const MAX_RADIUS = 5000;

type PlaceWorkspaces = Pick<Workspaces, "members" | "requireMember">;

const FIELDS =
  "id, name, latitude, longitude, radius, owner_id AS ownerId, shared";
/** The places that a person's turns in a workspace use: the shared ones and their own. */
const SEEN_BY =
  "workspace_id = $workspaceId AND deleted_at IS NULL AND (shared = 1 OR owner_id = $userId)";
/** The live place of the person in the workspace. */
const OWN =
  "workspace_id = $workspaceId AND owner_id = $userId AND deleted_at IS NULL AND id = $placeId";

/**
 * The places of each person in the workspace, which they add in their own Settings from a pin on a map. Like a
 * credential, a place is private to its owner's turns until they share it with every member's.
 */
export class Places {
  constructor(
    private readonly database: Database,
    private readonly workspaces: PlaceWorkspaces
  ) {}

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
        "SELECT inside, at FROM place_presence WHERE place_id = ? AND person_id = ?"
      )
      .get(placeId, personId) as { inside: number; at: number } | null;
    if (last && last.at > report.at) {
      return "stale";
    }
    this.database
      .query(
        "INSERT INTO place_presence (place_id, person_id, inside, at) VALUES ($placeId, $personId, $inside, $at) ON CONFLICT (place_id, person_id) DO UPDATE SET inside = $inside, at = $at"
      )
      .run({
        placeId,
        personId,
        inside: report.event === "arrive" ? 1 : 0,
        at: report.at,
      });
    return { before: last ? last.inside === 1 : null };
  }

  /** Whether the person was in the place when their iPhone last said; null when it never said. */
  inside(placeId: string, personId: string): boolean | null {
    const last = this.database
      .query(
        "SELECT inside FROM place_presence WHERE place_id = ? AND person_id = ?"
      )
      .get(placeId, personId) as { inside: number } | null;
    return last ? last.inside === 1 : null;
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

  private requireFreeName(
    workspaceId: string,
    userId: string,
    name: string,
    placeId: string | null
  ): void {
    const taken = this.database
      .query(
        "SELECT 1 FROM place WHERE workspace_id = ? AND owner_id = ? AND name = ? COLLATE NOCASE AND id IS NOT ?"
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

import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import type { User } from "../platform/auth.ts";
import { migrate } from "../platform/database.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";
import { Places } from "./places.ts";

const alice: User = { id: "alice", name: "Alice", email: "alice@example.com" };
const bob: User = { id: "bob", name: "Bob", email: "bob@example.com" };
const office = {
  name: "Office",
  latitude: 50.08,
  longitude: 14.42,
  radius: 200,
  shared: false,
};

const ikea = {
  osm_type: "way",
  osm_id: 258_949_900,
  category: "shop",
  type: "furniture",
  name: "IKEA",
  display_name: "IKEA, 4, Skandinávská, Brno",
  lat: "49.1555081",
  lon: "16.6274380",
  boundingbox: ["49.1545533", "49.1564071", "16.6264853", "16.6283754"],
  address: { road: "Skandinávská", house_number: "4", city: "Brno" },
};
const tesco = (osmId: number, road: string) => ({
  ...ikea,
  osm_type: "node",
  osm_id: osmId,
  name: "Tesco",
  type: "supermarket",
  boundingbox: ["49.17", "49.1701", "16.59", "16.5901"],
  address: { road, city: "Brno" },
});
const brno = {
  ...ikea,
  osm_type: "relation",
  osm_id: 438_171,
  category: "boundary",
  type: "administrative",
  name: "Brno",
  boundingbox: ["49.10", "49.29", "16.42", "16.73"],
};

/** OpenStreetMap's search with `rows`, which keeps the URLs that it gets. */
function nominatim(rows: readonly object[]) {
  const urls: URL[] = [];
  const request = (async (url: string) => {
    urls.push(new URL(url));
    return Response.json(rows);
  }) as unknown as typeof fetch;
  return { request, urls };
}

function setup(request?: typeof fetch) {
  const database = authDatabase();
  migrate(database);
  const workspaces = {
    requireMember(workspaceId: string, user: User) {
      if (workspaceId !== "home" || ![alice.id, bob.id].includes(user.id)) {
        throw new Error("Not found");
      }
      return { id: "home", name: "Home", role: "owner" };
    },
    members: () => [
      { userId: alice.id, name: alice.name },
      { userId: bob.id, name: bob.name },
    ],
  } as unknown as Pick<Workspaces, "members" | "requireMember">;
  return { database, places: new Places(database, workspaces, request) };
}

test("a place is private to its owner until they share it, and only they change it", () => {
  const { database, places } = setup();
  const place = places.create("home", alice, office);
  expect(place).toMatchObject({
    ...office,
    ownerId: alice.id,
    ownerName: "Alice",
  });
  expect(places.list("home", bob)).toEqual([]);
  expect(() => places.update("home", bob, place.id, office)).toThrow(
    "Not found"
  );
  places.update("home", alice, place.id, { ...office, shared: true });
  expect(places.list("home", bob).map(({ name }) => name)).toEqual(["Office"]);
  expect(() => places.remove("home", bob, place.id)).toThrow("Not found");
  expect(() => places.list("other", alice)).toThrow("Not found");
  database.close();
});

test("a place needs a pin, a radius iOS sees, and a name that is free again after a removal", () => {
  const { database, places } = setup();
  expect(() =>
    places.create("home", alice, { ...office, latitude: 91 })
  ).toThrow("Put the pin on the map");
  expect(() => places.create("home", alice, { ...office, radius: 20 })).toThrow(
    "The radius must be"
  );
  const first = places.create("home", alice, office);
  expect(() =>
    places.create("home", alice, { ...office, name: "office" })
  ).toThrow("already have a place");
  // Bob has his own office.
  places.create("home", bob, office);
  places.remove("home", alice, first.id);
  expect(places.list("home", alice)).toEqual([]);
  expect(places.find("home", first.id)?.name).toBe("Office");
  places.create("home", alice, office);
  expect(places.list("home", alice)).toHaveLength(1);
  database.close();
});

test("the search of points of interest finds specific places and leaves out areas", async () => {
  const { request, urls } = nominatim([ikea, brno]);
  const { database, places } = setup(request);
  expect(await places.searchPointsOfInterest("IKEA Brno")).toEqual([
    {
      osmId: "W258949900",
      name: "IKEA, Skandinávská 4, Brno",
      kind: "shop/furniture",
      address: ikea.display_name,
      latitude: 49.155_508_1,
      longitude: 16.627_438,
      radius: 150,
    },
  ]);
  expect(urls[0]?.searchParams.get("q")).toBe("IKEA Brno");
  database.close();
});

test("a point of interest stays out of Settings, is reused, and can have the name of another", async () => {
  const first = setup(nominatim([tesco(1, "Vídeňská")]).request);
  const saved = await first.places.savePointOfInterest("home", alice.id, "N1");
  expect(saved).toMatchObject({
    name: "Tesco, Vídeňská, Brno",
    ownerId: alice.id,
    shared: false,
    radius: 150,
  });
  expect(first.places.list("home", alice)).toEqual([]);
  expect(first.places.usable("home", alice.id)).toEqual([]);
  expect(first.places.pointsOfInterestOf("home", alice.id)).toEqual([saved.id]);
  expect(first.places.pointsOfInterestOf("home", bob.id)).toEqual([]);
  expect(() => first.places.update("home", alice, saved.id, office)).toThrow(
    "Not found"
  );
  expect(() => first.places.remove("home", alice, saved.id)).toThrow(
    "Not found"
  );
  // A place in Settings can have the same name.
  first.places.create("home", alice, { ...office, name: saved.name });
  first.database.close();

  // Two points of interest can read the same; the same one is one place.
  const rows: object[] = [tesco(2, "Vídeňská")];
  const { database, places } = setup((async () =>
    Response.json([
      rows.shift() ?? tesco(3, "Vídeňská"),
    ])) as unknown as typeof fetch);
  const second = await places.savePointOfInterest("home", alice.id, "N2");
  const third = await places.savePointOfInterest("home", alice.id, "N3");
  expect(third.id).not.toBe(second.id);
  expect(third.name).toBe(second.name);
  const again = await places.savePointOfInterest("home", alice.id, "N3");
  expect(again.id).toBe(third.id);
  database.close();
});

test("a point of interest must be a specific place that OpenStreetMap has", async () => {
  const { database, places } = setup(nominatim([brno]).request);
  await expect(
    places.savePointOfInterest("home", alice.id, "R438171")
  ).rejects.toThrow("not a specific place");
  await expect(
    places.savePointOfInterest("home", alice.id, "../search")
  ).rejects.toThrow("Give an id");
  database.close();
  const nothing = setup(nominatim([]).request);
  await expect(
    nothing.places.savePointOfInterest("home", alice.id, "W1")
  ).rejects.toThrow("does not have this place");
  nothing.database.close();
});

test("a large place gets a circle that holds it, and the search asks once a second", async () => {
  const times: number[] = [];
  const { database, places } = setup((async () => {
    times.push(Date.now());
    return Response.json([
      { ...ikea, boundingbox: ["50.0849", "50.1202", "14.2190", "14.2930"] },
    ]);
  }) as unknown as typeof fetch);
  const [first] = await places.search("Airport", 1);
  await places.search("Airport", 1);
  expect(first?.radius).toBeGreaterThan(2000);
  expect(first?.radius).toBeLessThanOrEqual(5000);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000);
  database.close();
});

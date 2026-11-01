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

function setup() {
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
  return { database, places: new Places(database, workspaces) };
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

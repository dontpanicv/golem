import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import { migrate } from "../platform/database.ts";
import { AppSignIns, ProfilePictures } from "./accounts.ts";

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("a sign-in waits 10 minutes for Google, and its code 60 seconds for the app", () => {
  const signIns = new AppSignIns();
  const session = (createdAt: number) => ({
    token: "token",
    createdAt: new Date(createdAt),
  });
  expect(() =>
    signIns.finish(signIns.start(challenge, 0), session(1), 10 * 60_000)
  ).toThrow("Sign in again");
  const late = signIns.finish(signIns.start(challenge, 0), session(1), 1000);
  expect(() => signIns.token(late, verifier, 61_000)).toThrow("Sign in again");
  const code = signIns.finish(signIns.start(challenge, 0), session(1), 1000);
  expect(signIns.token(code, verifier, 60_999)).toBe("token");
  expect(() => signIns.start("not a challenge")).toThrow(
    "Send the SHA-256 challenge of a verifier"
  );
});

test("a new profile picture replaces the old one, and only pictures are kept", async () => {
  const database = authDatabase();
  migrate(database);
  const pictures = new ProfilePictures(database);
  const jpeg = (byte: number) =>
    new File([new Uint8Array([0xff, 0xd8, 0xff, byte])], "picture.jpg");
  await expect(
    pictures.set("ada", new File(["<svg/>"], "picture.svg"))
  ).rejects.toThrow("Send a JPEG, PNG, or WebP picture");
  await expect(pictures.set("ada", undefined)).rejects.toThrow(
    "Send a JPEG, PNG, or WebP picture"
  );
  const first = await pictures.set("ada", jpeg(1));
  const second = await pictures.set("ada", jpeg(2));
  expect(pictures.ids(["ada", "bob"])).toEqual(new Map([["ada", second]]));
  expect(() => pictures.get(first)).toThrow("Not found");
  expect(pictures.get(second).contentType).toBe("image/jpeg");
  pictures.remove("ada");
  expect(pictures.ids(["ada"]).size).toBe(0);
  expect(() => pictures.get(second)).toThrow("Not found");
});

test("a person's Google picture is copied once at 256 px, and never again after they remove it", async () => {
  const database = authDatabase();
  migrate(database);
  const asked: string[] = [];
  const pictures = new ProfilePictures(database, (async (address: string) => {
    asked.push(address);
    return new Response(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])
    );
  }) as unknown as typeof fetch);
  // better-auth's tables, with only the columns that the copy reads. Cy's account was made with a password, and
  // Google was linked to it later, so only the ID token of the Google account has the picture.
  const idToken = `x.${Buffer.from(JSON.stringify({ picture: "https://lh3.googleusercontent.com/a/cy=s96-c" })).toString("base64url")}.x`;
  database.run(`CREATE TABLE user (id TEXT PRIMARY KEY, image TEXT);
	CREATE TABLE account (userId TEXT, providerId TEXT, idToken TEXT, updatedAt INTEGER);
	INSERT INTO user VALUES ('ada', 'https://lh3.googleusercontent.com/a/photo=s96-c'), ('bob', 'https://example.com/bob.png'), ('cy', NULL);
	INSERT INTO account VALUES ('cy', 'credential', NULL, 1), ('cy', 'google', '${idToken}', 2);`);
  await pictures.importGoogle();
  expect(asked).toEqual([
    "https://lh3.googleusercontent.com/a/photo=s256-c",
    "https://lh3.googleusercontent.com/a/cy=s256-c",
  ]);
  const id = pictures.ids(["ada", "bob"]).get("ada")!;
  expect(pictures.get(id).contentType).toBe("image/png");
  expect([...pictures.ids(["bob", "cy"]).keys()]).toEqual(["cy"]);
  pictures.remove("ada");
  await new ProfilePictures(database).importGoogle("ada");
  expect(pictures.ids(["ada"]).size).toBe(0);
});

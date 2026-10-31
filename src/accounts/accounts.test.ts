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

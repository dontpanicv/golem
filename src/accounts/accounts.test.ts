import { expect, test } from "bun:test";
import { AppSignIns } from "./accounts.ts";

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

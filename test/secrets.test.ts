import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secrets } from "../src/platform/secrets.ts";

test("first start creates a private key file; later starts read the same key", async () => {
  const config = await mkdtemp(join(tmpdir(), "golem-secrets-"));
  try {
    const first = await Secrets.load(config);
    const key = join(config, "secret.key");
    expect(await Bun.file(key).bytes()).toHaveLength(32);
    expect((await stat(key)).mode % 0o1000).toBe(0o600);

    const sealed = first.encrypt("family-secret");
    const later = await Secrets.load(config);
    expect(later.decrypt(sealed)).toBe("family-secret");
    expect(later.authSecret).toBe(first.authSecret);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});

test("each key seals its own data, and the auth secret is not the key", async () => {
  const secrets = Secrets.forTests();
  const sealed = secrets.encrypt("family-secret");
  expect(Buffer.from(sealed).toString("utf8")).not.toContain("family-secret");
  // A fresh nonce makes every seal different.
  expect(secrets.encrypt("family-secret")).not.toEqual(sealed);
  expect(secrets.decrypt(sealed)).toBe("family-secret");
  expect(() => Secrets.forTests().decrypt(sealed)).toThrow();
  const tampered = Uint8Array.from(sealed);
  tampered[12] = (tampered[12]! + 1) % 256;
  expect(() => secrets.decrypt(tampered)).toThrow();
  expect(secrets.authSecret).toMatch(/^[0-9a-f]{64}$/);
});

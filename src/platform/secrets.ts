import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Encrypts secrets at rest with a key kept in `config/`, apart from the data it protects. */
export class Secrets {
  private constructor(private readonly key: Buffer) {}

  /** Reads `config/secret.key`, creating it on first start. It stays out of the data backup on purpose. */
  static async load(configDirectory: string): Promise<Secrets> {
    const path = join(configDirectory, "secret.key");
    const file = Bun.file(path);
    if (await file.exists()) {
      // Also corrects a key that an older version left readable to others.
      await chmod(path, 0o600);
      return new Secrets(Buffer.from(await file.arrayBuffer()));
    }
    const key = randomBytes(32);
    // Bun.write ignores `mode`, so the file is made private when it is created, not after.
    await writeFile(path, key, { mode: 0o600, flag: "wx" });
    return new Secrets(key);
  }

  static forTests(): Secrets {
    return new Secrets(randomBytes(32));
  }

  /** The better-auth signing secret, derived so it differs from the encryption key. */
  get authSecret(): string {
    return createHash("sha256")
      .update(this.key)
      .update("better-auth")
      .digest("hex");
  }

  /** 32 bytes for `purpose`, derived from the key, so a lost key also loses them and they need no storage. */
  derive(purpose: string): Buffer {
    return createHash("sha256").update(this.key).update(purpose).digest();
  }

  encrypt(plaintext: string): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]);
  }

  decrypt(sealed: Uint8Array): string {
    const data = Buffer.from(sealed);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      data.subarray(0, 12)
    );
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([
      decipher.update(data.subarray(12, data.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  }
}

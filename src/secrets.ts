import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

/** Encrypts secrets at rest with a key kept in `config/`, apart from the data it protects. */
export class Secrets {
	private constructor(private readonly key: Buffer) {}

	/** Reads `config/secret.key`, creating it on first start. It stays out of the data backup on purpose. */
	static async load(configDirectory: string): Promise<Secrets> {
		const file = Bun.file(join(configDirectory, "secret.key"));
		if (await file.exists()) return new Secrets(Buffer.from(await file.arrayBuffer()));
		const key = randomBytes(32);
		await Bun.write(file, key);
		await chmod(file.name!, 0o600);
		return new Secrets(key);
	}

	static forTests(): Secrets {
		return new Secrets(randomBytes(32));
	}

	/** The better-auth signing secret, derived so it differs from the encryption key. */
	get authSecret(): string {
		return createHash("sha256").update(this.key).update("better-auth").digest("hex");
	}

	encrypt(plaintext: string): Uint8Array {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, iv);
		const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
		return Buffer.concat([iv, body, cipher.getAuthTag()]);
	}

	decrypt(sealed: Uint8Array): string {
		const data = Buffer.from(sealed);
		const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
		decipher.setAuthTag(data.subarray(data.length - 16));
		return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString("utf8");
	}
}

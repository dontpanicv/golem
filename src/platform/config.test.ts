import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./config.ts";

test("config/ and data/ are for Golem's user only, also when an older version made them", async () => {
  const root = await mkdtemp(join(tmpdir(), "golem-config-"));
  const env = {
    GOLEM_CONFIG: join(root, "config"),
    GOLEM_DATA: join(root, "data"),
  };
  try {
    await mkdir(env.GOLEM_DATA, { mode: 0o755 });
    await chmod(env.GOLEM_DATA, 0o755);
    await readConfig(env).catch(() => undefined);
    expect((await stat(env.GOLEM_CONFIG)).mode % 0o1000).toBe(0o700);
    expect((await stat(env.GOLEM_DATA)).mode % 0o1000).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first start creates config/golem.toml and data/; later starts read it", async () => {
  const root = await mkdtemp(join(tmpdir(), "golem-config-"));
  const env = {
    GOLEM_CONFIG: join(root, "config"),
    GOLEM_DATA: join(root, "data"),
  };
  try {
    // Nobody can sign in until the Google client is set.
    await expect(readConfig(env)).rejects.toThrow(
      "google.client_id must be a text value"
    );
    expect(existsSync(join(root, "data"))).toBe(true);
    const template = await Bun.file(join(root, "config", "golem.toml")).text();
    await Bun.write(
      join(root, "config", "golem.toml"),
      template
        .replace('client_id = ""', 'client_id = "id"')
        .replace('client_secret = ""', 'client_secret = "secret"')
    );
    expect(await readConfig(env)).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      baseUrl: "http://localhost:3000",
      shareUrl: null,
      allowedEmails: [],
      google: { clientId: "id", clientSecret: "secret" },
    });
    const google = '[google]\nclient_id = "id"\nclient_secret = "secret"\n';
    await Bun.write(
      join(root, "config", "golem.toml"),
      `base_url = "http://golem.home"\nport = 8080\nhost = "0.0.0.0"\nshare_url = "https://a.golem.home/"\nallowed_emails = ["Anna@Example.com"]\n${google}`
    );
    expect(await readConfig(env)).toMatchObject({
      host: "0.0.0.0",
      shareUrl: "https://a.golem.home",
      port: 8080,
      baseUrl: "http://golem.home",
      allowedEmails: ["anna@example.com"],
    });
    await Bun.write(join(root, "config", "golem.toml"), 'port = "eighty"\n');
    await expect(readConfig(env)).rejects.toThrow(
      "port must be a whole number"
    );
    await Bun.write(
      join(root, "config", "golem.toml"),
      `allowed_emails = "anna@example.com"\n${google}`
    );
    await expect(readConfig(env)).rejects.toThrow(
      "allowed_emails must be a list of text values"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

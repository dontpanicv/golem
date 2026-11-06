import { mkdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { program, type Requirement } from "./requirements.ts";

/**
 * Local models that a pinned llama.cpp `llama-server` child process runs. The runtime and each model download once into
 * `data/runtime/` and `data/models/`, checked against pinned sha256 hashes.
 */
export const LLAMA_BUILD = "b11871";
const RELEASES = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}`;
const RUNTIMES: Record<string, { url: string; sha256: string }> = {
  "darwin-arm64": {
    url: `${RELEASES}/llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`,
    sha256: "389977376e89be4708e3e20c2f0c70b7252d15f5b848e754a26cf5fb06748d7c",
  },
  "linux-x64": {
    url: `${RELEASES}/llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz`,
    sha256: "b0a29cc015275b751c0323875db007583b3bd1cb31e921087dd3cd3d37d5eef9",
  },
  "linux-arm64": {
    url: `${RELEASES}/llama-${LLAMA_BUILD}-bin-ubuntu-arm64.tar.gz`,
    sha256: "7274d21d4adc889fbcfcb89f422d33d66ccba22d28650a580aa3f64acc9586f3",
  },
};

/** A file of a model, pinned by its hash. */
export interface ModelFile {
  /** Its name in `data/models/`, or an absolute path. */
  readonly file: string;
  readonly url: string;
  readonly sha256: string;
}

/** What the local models need before they download the rest; Golem checks it before it starts. */
export function llamaRequirements(): Requirement[] {
  const platform = `${process.platform}-${process.arch}`;
  return [
    {
      name: "llama.cpp build",
      purpose: "meaning in search, and finding tasks",
      install: `a machine of ${Object.keys(RUNTIMES).join(", ")}`,
      problem: RUNTIMES[platform] ? null : `none for ${platform}`,
    },
    program("tar", "unpacking llama.cpp", "part of macOS and Linux"),
  ];
}

/** One `llama-server` with its model files; it downloads what is missing, and restarts the server if it exits. */
export class LlamaServer {
  /** The server's address while it runs. */
  base: string | undefined;
  private process: ReturnType<typeof Bun.spawn> | undefined;
  private stopped = false;

  constructor(
    private readonly dataDirectory: string,
    private readonly files: readonly ModelFile[],
    /** The server's arguments, after the paths of `files` in their order. */
    private readonly args: (paths: readonly string[]) => string[]
  ) {}

  /** Starts in the background; `failed` gets the error when the server cannot run. */
  start(failed: (error: unknown) => void): void {
    this.run().catch(failed);
  }

  stop(): void {
    this.stopped = true;
    this.base = undefined;
    this.process?.kill();
  }

  private async run(): Promise<void> {
    const runtime = RUNTIMES[`${process.platform}-${process.arch}`];
    if (!runtime) {
      throw new Error(
        `No llama.cpp build for ${process.platform}-${process.arch}`
      );
    }
    const models = join(this.dataDirectory, "models");
    const runtimes = join(this.dataDirectory, "runtime");
    const server = join(runtimes, `llama-${LLAMA_BUILD}`, "llama-server");
    // A file with an absolute path, such as a model that an eval compares, stays where it is.
    const paths = this.files.map((file) => resolve(models, file.file));
    for (const [index, file] of this.files.entries()) {
      await download(file.url, file.sha256, paths[index]!);
    }
    await unpackRuntime(runtime, runtimes, server);
    while (!this.stopped) {
      const port = await freePort();
      this.process = Bun.spawn(
        [
          server,
          ...this.args(paths),
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--no-webui",
          "--offline",
        ],
        { stdout: "ignore", stderr: "ignore" }
      );
      const base = `http://127.0.0.1:${port}`;
      if (await healthy(base, this.process)) {
        this.base = base;
      }
      await this.process.exited;
      this.base = undefined;
      if (!this.stopped) {
        console.error(
          `llama-server exited with ${this.process.exitCode}; restarting in 5 s`
        );
        await Bun.sleep(5000);
      }
    }
  }
}

/** The runtime unpacks once; two servers that start together unpack it one after the other. */
let unpacking: Promise<void> = Promise.resolve();

function unpackRuntime(
  runtime: { url: string; sha256: string },
  runtimes: string,
  server: string
): Promise<void> {
  unpacking = unpacking.then(async () => {
    if (await Bun.file(server).exists()) {
      return;
    }
    const archive = join(runtimes, `llama-${LLAMA_BUILD}.tar.gz`);
    await download(runtime.url, runtime.sha256, archive);
    const tar = Bun.spawnSync(["tar", "xzf", archive, "-C", runtimes]);
    if (tar.exitCode !== 0) {
      throw new Error(`Could not unpack llama.cpp: ${tar.stderr.toString()}`);
    }
    await rm(archive);
  });
  return unpacking;
}

/** Streams `url` to `<path>.part`, hashing as it goes, and keeps it only if the sha256 matches. */
export async function download(
  url: string,
  sha256: string,
  path: string
): Promise<void> {
  if (await Bun.file(path).exists()) {
    return;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  const response = await fetch(url);
  if (!(response.ok && response.body)) {
    throw new Error(`Download failed: ${url} (${response.status})`);
  }
  const part = `${path}.part`;
  const hash = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(part).writer();
  for await (const chunk of response.body) {
    hash.update(chunk);
    writer.write(chunk);
  }
  await writer.end();
  const actual = hash.digest("hex");
  if (actual !== sha256) {
    await rm(part, { force: true });
    throw new Error(`Checksum mismatch for ${url}: ${actual}`);
  }
  await rename(part, path);
}

async function healthy(
  base: string,
  child: ReturnType<typeof Bun.spawn>
): Promise<boolean> {
  // A large model loads for a while.
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    if (child.exitCode !== null) {
      return false;
    }
    if (
      await fetch(`${base}/health`).then(
        (response) => response.ok,
        () => false
      )
    ) {
      return true;
    }
    await Bun.sleep(100);
  }
  return false;
}

function freePort(): Promise<number> {
  return new Promise((settle, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => settle(port));
    });
  });
}

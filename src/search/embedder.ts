import { mkdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

/**
 * Text, picture, and audio embeddings from Google's EmbeddingGemma 2 (Apache 2.0), run by a pinned llama.cpp `llama-server` child process.
 * The model and runtime download once into `data/models/` and `data/runtime/`, checked against pinned sha256 hashes.
 * See research_notes "embeddinggemma_2.md" for why this runtime and these flags.
 */
export interface Embedder {
  /** One L2-normalized vector per input. Text already carries its prompt prefix; media gets none. */
  embed: (inputs: readonly EmbedInput[]) => Promise<Float32Array[]>;
  /** Identifies the vectors: when it changes, every workspace index re-embeds. */
  readonly fingerprint: string;
  /** Whether vectors can be made now; until then search uses keywords only. */
  ready: () => boolean;
}

/** Text, a JPEG picture, or a 16 kHz mono WAV recording. */
export type EmbedInput =
  | string
  | { readonly image: Uint8Array }
  | { readonly audio: Uint8Array };

export const DIMENSIONS = 768;
export const queryPrompt = (query: string) =>
  `task: search result | query: ${query}`;
export const documentPrompt = (text: string, title?: string) =>
  `title: ${title?.trim() || "none"} | text: ${text}`;

const HUGGING_FACE =
  "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/bfcd298762cc34d0357ece5ebdd31791a3a374d8";
const MODEL = {
  file: "embeddinggemma-2-Q8_0.gguf",
  url: `${HUGGING_FACE}/embeddinggemma-2-Q8_0.gguf`,
  sha256: "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135",
};
/** The vision and audio encoders: pictures, scanned pages, video frames, and sound. */
const PROJECTOR = {
  file: "mmproj-embeddinggemma-2-Q8_0.gguf",
  url: `${HUGGING_FACE}/mmproj-embeddinggemma-2-Q8_0.gguf`,
  sha256: "c4a8a52691ecef40618438928bdf9e68379b854e24166f292592353db0aab64f",
};
const LLAMA_BUILD = "b11871";
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
/** Every input must fit one micro-batch; chunks stay far below it. */
const MAX_TOKENS = 2048;
const TEXT_BATCH = 16;
const MEDIA_BATCH = 8;

export class LlamaEmbedder implements Embedder {
  readonly fingerprint =
    `google/embeddinggemma-2@bfcd298 Q8_0+mmproj llama.cpp-${LLAMA_BUILD} mean-pooled l2 768`;
  private base: string | undefined;
  private process: ReturnType<typeof Bun.spawn> | undefined;
  private stopped = false;

  constructor(private readonly dataDirectory: string) {}

  /** Downloads what is missing and starts the server in the background; restarts it if it exits. */
  start(): void {
    this.run().catch((error: unknown) =>
      console.error(
        "Embeddings are unavailable; search uses keywords only.",
        error
      )
    );
  }

  ready(): boolean {
    return this.base !== undefined;
  }

  async embed(inputs: readonly EmbedInput[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    const batch = inputs.some((input) => typeof input !== "string")
      ? MEDIA_BATCH
      : TEXT_BATCH;
    for (let start = 0; start < inputs.length; start += batch) {
      if (!this.base) {
        throw new Error("The embedding model is not running");
      }
      const response = await fetch(`${this.base}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: inputs.slice(start, start + batch).map(serverInput),
        }),
      });
      const body = (await response.json()) as {
        data?: { embedding: number[] }[];
        error?: unknown;
      };
      if (!(response.ok && body.data)) {
        throw new Error(
          `Embedding failed: ${JSON.stringify(body.error ?? body)}`
        );
      }
      for (const item of body.data) {
        vectors.push(Float32Array.from(item.embedding));
      }
    }
    return vectors;
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
    const model = join(models, MODEL.file);
    const projector = join(models, PROJECTOR.file);
    await download(MODEL.url, MODEL.sha256, model);
    await download(PROJECTOR.url, PROJECTOR.sha256, projector);
    if (!(await Bun.file(server).exists())) {
      const archive = join(runtimes, `llama-${LLAMA_BUILD}.tar.gz`);
      await download(runtime.url, runtime.sha256, archive);
      const tar = Bun.spawnSync(["tar", "xzf", archive, "-C", runtimes]);
      if (tar.exitCode !== 0) {
        throw new Error(`Could not unpack llama.cpp: ${tar.stderr.toString()}`);
      }
      await rm(archive);
    }
    while (!this.stopped) {
      const port = await freePort();
      this.process = Bun.spawn(
        [
          server,
          "-m",
          model,
          "--mmproj",
          projector,
          "--embeddings",
          "--pooling",
          "mean",
          "--embd-normalize",
          "2",
          "-c",
          String(MAX_TOKENS * 4),
          "-np",
          "4",
          "-b",
          String(MAX_TOKENS),
          "-ub",
          String(MAX_TOKENS),
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

/** llama-server's input: text as is, media as OpenAI-style content parts. */
function serverInput(input: EmbedInput): unknown {
  if (typeof input === "string") {
    return input;
  }
  if ("image" in input) {
    return {
      content: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${Buffer.from(input.image).toString("base64")}`,
          },
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "input_audio",
        input_audio: {
          data: Buffer.from(input.audio).toString("base64"),
          format: "wav",
        },
      },
    ],
  };
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
  for (let attempt = 0; attempt < 600; attempt += 1) {
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
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** float32 → float16 bytes for a SQLite BLOB. */
export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(new Float16Array(vector).buffer);
}

export function fromBlob(blob: Uint8Array): Float16Array {
  const copy = blob.slice();
  return new Float16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
}

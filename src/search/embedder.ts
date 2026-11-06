import { LLAMA_BUILD, LlamaServer } from "../platform/llama.ts";

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
/** Every input must fit one micro-batch; chunks stay far below it. */
const MAX_TOKENS = 2048;
const TEXT_BATCH = 16;
const MEDIA_BATCH = 8;

export class LlamaEmbedder implements Embedder {
  readonly fingerprint =
    `google/embeddinggemma-2@bfcd298 Q8_0+mmproj llama.cpp-${LLAMA_BUILD} mean-pooled l2 768`;
  private readonly server: LlamaServer;

  constructor(dataDirectory: string) {
    this.server = new LlamaServer(
      dataDirectory,
      [MODEL, PROJECTOR],
      ([model, projector]) => [
        "-m",
        model!,
        "--mmproj",
        projector!,
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
      ]
    );
  }

  /** Downloads what is missing and starts the server in the background; restarts it if it exits. */
  start(): void {
    this.server.start((error: unknown) =>
      console.error(
        "Embeddings are unavailable; search uses keywords only.",
        error
      )
    );
  }

  ready(): boolean {
    return this.server.base !== undefined;
  }

  async embed(inputs: readonly EmbedInput[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    const batch = inputs.some((input) => typeof input !== "string")
      ? MEDIA_BATCH
      : TEXT_BATCH;
    for (let start = 0; start < inputs.length; start += batch) {
      const { base } = this.server;
      if (!base) {
        throw new Error("The embedding model is not running");
      }
      const response = await fetch(`${base}/v1/embeddings`, {
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
    this.server.stop();
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

/** float32 → float16 bytes for a SQLite BLOB. */
export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(new Float16Array(vector).buffer);
}

export function fromBlob(blob: Uint8Array): Float16Array {
  const copy = blob.slice();
  return new Float16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
}

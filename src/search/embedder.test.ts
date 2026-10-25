import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { download, fromBlob, LlamaEmbedder, toBlob } from "./embedder.ts";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "golem-embedder-"));
});
afterAll(() => rm(directory, { recursive: true, force: true }));

/** Calls `check` until it returns true, or fails after `milliseconds`. */
async function until(
  check: () => boolean | Promise<boolean>,
  milliseconds = 5000
): Promise<void> {
  const end = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error("The condition did not become true in time");
    }
    await Bun.sleep(20);
  }
}

test("a vector keeps its values through a float16 blob", () => {
  const vector = Float32Array.from([0.5, -0.25, 0.1, 1]);
  const blob = toBlob(vector);
  expect(blob.byteLength).toBe(8);
  const values = [...fromBlob(blob)];
  for (const [index, value] of values.entries()) {
    expect(value).toBeCloseTo(vector[index]!, 3);
  }
  // SQLite can give a view into a larger buffer at an odd offset.
  const padded = new Uint8Array(blob.byteLength + 1);
  padded.set(blob, 1);
  expect([...fromBlob(padded.subarray(1))]).toEqual(values);
});

describe("download", () => {
  const content = "model weights";
  const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  let requests = 0;
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        requests += 1;
        return new URL(request.url).pathname === "/model"
          ? new Response(content)
          : new Response("missing", { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));

  test("a file with the correct checksum is kept, and is not downloaded again", async () => {
    const path = join(directory, "download", "nested", "model.gguf");
    await download(`${server.url}model`, sha256, path);
    expect(await Bun.file(path).text()).toBe(content);
    expect(await Bun.file(`${path}.part`).exists()).toBe(false);
    const before = requests;
    await download(`${server.url}model`, sha256, path);
    expect(requests).toBe(before);
  });

  test("a file with an incorrect checksum is deleted", async () => {
    const path = join(directory, "download", "wrong.gguf");
    await expect(
      download(`${server.url}model`, "0".repeat(64), path)
    ).rejects.toThrow("Checksum mismatch");
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await Bun.file(`${path}.part`).exists()).toBe(false);
  });

  test("a failed request gives an error", async () => {
    const path = join(directory, "download", "absent.gguf");
    await expect(download(`${server.url}absent`, sha256, path)).rejects.toThrow(
      "(404)"
    );
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

/**
 * A stand-in llama-server: it answers health checks, writes its arguments and every input to a log, returns each
 * input's position and batch size as its vector, refuses the input "fail", and exits on `/exit`.
 */
const FAKE_SERVER = `
import { appendFileSync } from "node:fs";
const [log, ...args] = Bun.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
appendFileSync(log, JSON.stringify({ args }) + "\\n");
Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    if (path === "/exit") {
      setTimeout(() => process.exit(3), 10);
      return new Response("bye");
    }
    const { input } = await request.json();
    appendFileSync(log, JSON.stringify({ input }) + "\\n");
    if (input.includes("fail")) {
      return Response.json({ error: { message: "bad input" } }, { status: 400 });
    }
    return Response.json({ data: input.map((_, index) => ({ embedding: [index, input.length] })) });
  },
});
`;

const platforms = ["darwin-arm64", "linux-x64", "linux-arm64"];

describe.skipIf(!platforms.includes(`${process.platform}-${process.arch}`))(
  "LlamaEmbedder",
  () => {
    let data: string;
    let log: string;
    let embedder: LlamaEmbedder;

    const entries = async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { args?: string[]; input?: unknown[] }
        );
    const ports = async () =>
      (await entries())
        .filter((entry) => entry.args)
        .map((entry) => entry.args![entry.args!.indexOf("--port") + 1]);
    const inputs = async () =>
      (await entries())
        .filter((entry) => entry.input)
        .map((entry) => entry.input!);

    // The model and the runtime are already in place, so nothing is downloaded.
    beforeAll(async () => {
      data = join(directory, "data");
      log = join(directory, "llama.log");
      const runtime = join(data, "runtime", "llama-b11871");
      await mkdir(runtime, { recursive: true });
      await Bun.write(
        join(data, "models", "embeddinggemma-2-Q8_0.gguf"),
        "model"
      );
      await Bun.write(
        join(data, "models", "mmproj-embeddinggemma-2-Q8_0.gguf"),
        "projector"
      );
      const script = join(directory, "fake-llama.ts");
      await Bun.write(script, FAKE_SERVER);
      const server = join(runtime, "llama-server");
      await Bun.write(
        server,
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "${log}" "$@"\n`
      );
      await chmod(server, 0o755);
      embedder = new LlamaEmbedder(data);
      embedder.start();
      await until(() => embedder.ready());
    });
    afterAll(() => embedder.stop());

    test("the server gets the model, the projector, and offline mode", async () => {
      const [args] = (await entries()).map((entry) => entry.args);
      expect(args).toContain(
        join(data, "models", "embeddinggemma-2-Q8_0.gguf")
      );
      expect(args).toContain(
        join(data, "models", "mmproj-embeddinggemma-2-Q8_0.gguf")
      );
      expect(args).toContain("--embeddings");
      expect(args).toContain("--offline");
    });

    test("text goes in batches of 16, and the vectors keep the input order", async () => {
      const texts = Array.from({ length: 20 }, (_, index) => `text ${index}`);
      const vectors = await embedder.embed(texts);
      expect(vectors.map((vector) => [...vector])).toEqual([
        ...Array.from({ length: 16 }, (_, index) => [index, 16]),
        ...Array.from({ length: 4 }, (_, index) => [index, 4]),
      ]);
      expect((await inputs()).slice(-2)).toEqual([
        texts.slice(0, 16),
        texts.slice(16),
      ]);
    });

    test("pictures and audio go in batches of 8 as base64 content parts", async () => {
      const picture = { image: new Uint8Array([0xff, 0xd8]) };
      const sound = { audio: new Uint8Array([0x52, 0x49]) };
      const vectors = await embedder.embed([
        picture,
        sound,
        ...Array.from({ length: 8 }, () => "caption"),
      ]);
      expect(vectors.length).toBe(10);
      const [first, second] = (await inputs()).slice(-2);
      expect(first!.length).toBe(8);
      expect(second!.length).toBe(2);
      expect(first![0]).toEqual({
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,/9g=" },
          },
        ],
      });
      expect(first![1]).toEqual({
        content: [
          { type: "input_audio", input_audio: { data: "Ukk=", format: "wav" } },
        ],
      });
      expect(first![2]).toBe("caption");
    });

    test("an error from the server rejects the whole call", async () => {
      await expect(embedder.embed(["fail"])).rejects.toThrow(
        'Embedding failed: {"message":"bad input"}'
      );
    });

    test(
      "the server starts again on a new port after it exits",
      async () => {
        const [port] = await ports();
        await fetch(`http://127.0.0.1:${port}/exit`);
        await until(() => !embedder.ready());
        await expect(embedder.embed(["text"])).rejects.toThrow(
          "The embedding model is not running"
        );
        await until(() => embedder.ready(), 10_000);
        expect((await ports()).length).toBe(2);
        expect((await embedder.embed(["text"])).length).toBe(1);
      },
      { timeout: 15_000 }
    );

    test("stop ends the server and makes the embedder not ready", async () => {
      const port = (await ports()).at(-1);
      embedder.stop();
      expect(embedder.ready()).toBe(false);
      await until(() =>
        fetch(`http://127.0.0.1:${port}/health`).then(
          () => false,
          () => true
        )
      );
    });
  }
);

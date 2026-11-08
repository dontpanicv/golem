import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribe } from "./transcribe.ts";

let directory: string;

async function script(name: string, body: string): Promise<string> {
  const path = join(directory, name);
  await Bun.write(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "golem-transcribe-test-"));
  // A model that is there does not download.
  await mkdir(join(directory, "models"));
  await Bun.write(join(directory, "models/ggml-large-v3-turbo.bin"), "model");
});

afterAll(() => rm(directory, { recursive: true, force: true }));

const temporaryFolders = async () =>
  (await readdir(tmpdir())).filter((name) =>
    /^golem-transcribe-(?!test-)/.test(name)
  );

test("gives what whisper prints for the file's sound, in the language spoken, and leaves no audio behind", async () => {
  const before = await temporaryFolders();
  const ffmpeg = await script(
    "ffmpeg-ok",
    'for last; do :; done\ntest "$3" = "/files/talk.mp4" && echo sound > "$last"'
  );
  const whisper = await script(
    "whisper-ok",
    'test "$(cat "$4")" = sound || exit 1\necho "  [00:00:00.000 --> 00:00:01.000]  $5 $6 $2"'
  );
  expect(
    await transcribe(directory, "/files/talk.mp4", undefined, {
      ffmpeg,
      whisper,
    })
  ).toBe(
    `[00:00:00.000 --> 00:00:01.000]  -l auto ${join(directory, "models/ggml-large-v3-turbo.bin")}`
  );
  expect(await temporaryFolders()).toEqual(before);
});

test("says which program failed and why", async () => {
  const ffmpeg = await script(
    "ffmpeg-bad",
    "echo 'no audio stream' >&2\nexit 1"
  );
  await expect(
    transcribe(directory, "/files/note.txt", undefined, {
      ffmpeg,
      whisper: "unused",
    })
  ).rejects.toThrow("ffmpeg-bad failed: no audio stream");
});

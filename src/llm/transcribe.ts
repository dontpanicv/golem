import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { download } from "../platform/llama.ts";
import { program, type Requirement } from "../platform/requirements.ts";

/** Whisper's large turbo model in whisper.cpp's format, which downloads once at the first transcription. */
const MODEL = {
  file: "ggml-large-v3-turbo.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
  sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
};
/** A program that transcription runs is stopped after this time, below the longest a script runs. */
const RUN_TIMEOUT = 14 * 60_000;
const PROGRAMS = { ffmpeg: "ffmpeg", whisper: "whisper-cli" };

/** One download at a time, so that two first transcriptions do not write the same file. */
let downloading: Promise<void> = Promise.resolve();

/** What transcription needs from this machine, besides the ffmpeg that search also checks. */
export function transcribeRequirements(): Requirement[] {
  return [
    program(
      "whisper-cli",
      "turning audio and video into text",
      "brew install whisper-cpp"
    ),
  ];
}

/** The speech of an audio or video file, as whisper.cpp prints it: one line for each segment, with its times. */
export async function transcribe(
  dataDirectory: string,
  path: string,
  signal: AbortSignal | undefined,
  programs = PROGRAMS
): Promise<string> {
  const model = join(dataDirectory, "models", MODEL.file);
  downloading = downloading
    .catch(() => undefined)
    .then(() => download(MODEL.url, MODEL.sha256, model));
  await downloading;
  const directory = await mkdtemp(join(tmpdir(), "golem-transcribe-"));
  const audio = join(directory, "audio.wav");
  try {
    await run(
      [
        programs.ffmpeg,
        "-nostdin",
        "-i",
        path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        audio,
      ],
      signal
    );
    const text = await run(
      [programs.whisper, "-m", model, "-f", audio, "-l", "auto", "-np"],
      signal
    );
    return text.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function run(
  command: string[],
  signal: AbortSignal | undefined
): Promise<string> {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: RUN_TIMEOUT,
    ...(signal ? { signal } : {}),
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `${basename(command[0]!)} failed: ${child.signalCode ?? error.slice(-300)}`
    );
  }
  return output;
}

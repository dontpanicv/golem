import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { unzipSync } from "fflate";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { program, type Requirement } from "../platform/requirements.ts";
import { chunk, isProse } from "./workspace-index.ts";

/**
 * Turns a file into searchable segments, after DigUp (github.com/ARahim3/DigUp, MIT), which supports the same kinds:
 * documents and Office files as text, PDFs by page, pictures, audio, and video. Text goes to keywords and, when it
 * reads as prose, to text vectors. Pictures, scanned pages, video frames, and audio windows go to EmbeddingGemma 2's
 * image and audio encoders. Media needs ffmpeg; scanned pages need poppler (`pdftoppm`); OCR needs tesseract.
 * Without a tool, that part is skipped and the file stays findable by its name.
 */
export type ExtractedSegment =
  | {
      readonly key: string;
      readonly modality: "text";
      readonly text: string;
      readonly loc?: number;
    }
  /** Keywords only: file names and OCR text. */
  | {
      readonly key: string;
      readonly modality: "none";
      readonly text: string;
      readonly loc?: number;
    }
  | {
      readonly key: string;
      readonly modality: "image" | "audio";
      /** What the result shows: "Page 3", "Photo", "0:30–1:00". */
      readonly text: string;
      /** A JPEG for images, a 16 kHz mono WAV for audio. */
      readonly media: Uint8Array;
      readonly loc?: number;
      readonly locEnd?: number;
    };

export interface Extraction {
  readonly note?: string;
  readonly segments: readonly ExtractedSegment[];
  readonly title?: string;
}

export type FileKind =
  | "document"
  | "pdf"
  | "image"
  | "audio"
  | "video"
  | "other";

const DOCUMENTS = new Set(
  "txt text md markdown typ rtf doc docx odt html htm xlsx pptx ods odp csv tsv json jsonl yaml yml toml xml log ics vcf eml org rst adoc tex".split(
    " "
  )
);
const IMAGES = new Set(
  "jpg jpeg png gif webp heic heif tif tiff bmp avif".split(" ")
);
const AUDIO = new Set(
  "mp3 m4a wav aac flac ogg oga opus aiff aif caf wma".split(" ")
);
const VIDEO = new Set("mp4 mov m4v mkv webm avi mpg mpeg 3gp wmv".split(" "));
const SCREENSHOT_PREFIXES = ["screenshot", "screen shot", "cleanshot", "scr-"];

const MAX_TEXT_BYTES = 50_000_000;
const MAX_CHUNKS = 5000;
/** A PDF page with less text than this is a scan or a picture: it is embedded as an image. */
const PAGE_TEXT_MINIMUM = 200;
const PAGE_VECTOR_CHARACTERS = 4000;
const AUDIO_WINDOW_SECONDS = 30;
const AUDIO_HOP_SECONDS = 25;
const AUDIO_MAX_SECONDS = 4 * 3600;
const SILENCE_RMS = 0.003;
const VIDEO_FRAME_EVERY_SECONDS = 3;
const VIDEO_MAX_FRAMES = 1200;

export const tools = {
  ffmpeg: Bun.which("ffmpeg"),
  ffprobe: Bun.which("ffprobe"),
  pdftoppm: Bun.which("pdftoppm"),
  tesseract: Bun.which("tesseract"),
  sips: Bun.which("sips"),
  textutil: Bun.which("textutil"),
};

/** The programs extraction runs; Golem checks them before it starts. */
export function extractRequirements(): Requirement[] {
  return [
    program(
      "ffmpeg",
      "pictures, audio, and video in search",
      "brew install ffmpeg (Linux: apt install ffmpeg)"
    ),
    program(
      "ffprobe",
      "the length of audio and video in search",
      "brew install ffmpeg (Linux: apt install ffmpeg)"
    ),
    program(
      "pdftoppm",
      "scanned PDF pages in search",
      "brew install poppler (Linux: apt install poppler-utils)"
    ),
    program(
      "tesseract",
      "text in pictures and scans",
      "brew install tesseract (Linux: apt install tesseract-ocr)"
    ),
    ...(process.platform === "darwin"
      ? [
          program("sips", "pictures that ffmpeg cannot read", "part of macOS"),
          program("textutil", "legacy Word files", "part of macOS"),
        ]
      : []),
  ];
}

export function kindOf(path: string): FileKind {
  const extension = extname(path).slice(1).toLowerCase();
  if (extension === "pdf") {
    return "pdf";
  }
  if (DOCUMENTS.has(extension)) {
    return "document";
  }
  if (IMAGES.has(extension)) {
    return "image";
  }
  if (AUDIO.has(extension)) {
    return "audio";
  }
  if (VIDEO.has(extension)) {
    return "video";
  }
  return "other";
}

/** Files nobody means to search: system files and downloads in progress. */
export function isIgnored(name: string): boolean {
  return (
    /^(\.|~\$|Thumbs\.db$|desktop\.ini$)/i.test(name) ||
    /\.(part|crdownload|download|tmp|swp)$/i.test(name)
  );
}

/** Reads `path` into segments. The caller adds the file-name segment. */
export async function extract(path: string): Promise<Extraction> {
  switch (kindOf(path)) {
    case "document":
      return documentSegments(path);
    case "pdf":
      return pdfSegments(path);
    case "image":
      return imageSegments(path);
    case "audio":
      return audioSegments(path, "");
    case "video":
      return videoSegments(path);
    default:
      return { segments: [] };
  }
}

/** The whole text of a document or PDF, for an agent to read; `null` for pictures, audio, video, and other files. */
export async function readText(path: string): Promise<string | null> {
  switch (kindOf(path)) {
    case "document":
      return documentText(path);
    case "pdf": {
      const document = await getDocumentProxy(
        new Uint8Array(await Bun.file(path).arrayBuffer())
      );
      const { text } = await extractText(document, { mergePages: false });
      return text
        .map((page, index) => `[Page ${index + 1}]\n${page.trim()}`)
        .join("\n\n");
    }
    default:
      return null;
  }
}

// Documents

async function documentSegments(path: string): Promise<Extraction> {
  if (Bun.file(path).size > MAX_TEXT_BYTES) {
    return { segments: [], note: "too large to read" };
  }
  const text = await documentText(path);
  const title = extname(path).match(/^\.(md|markdown)$/i)
    ? text.match(/^#\s+(.+)$/m)?.[1]?.trim()
    : undefined;
  const parts = chunk(text).slice(0, MAX_CHUNKS);
  return {
    title,
    segments: parts.map((part, number) => ({
      key: `chunk:${number}`,
      modality: "text",
      text: part,
      loc: number,
    })),
  };
}

async function documentText(path: string): Promise<string> {
  const extension = extname(path).slice(1).toLowerCase();
  switch (extension) {
    case "html":
    case "htm":
      return htmlText(await Bun.file(path).text());
    case "docx":
      return xmlText(
        zipEntry(path, "word/document.xml"),
        ["w:p"],
        ["w:br", "w:cr", "w:tab"]
      );
    case "odt":
      return xmlText(
        zipEntry(path, "content.xml"),
        ["text:p", "text:h"],
        ["text:line-break", "text:tab", "text:s"]
      );
    case "xlsx":
      return xlsxText(path);
    case "ods":
      return xmlText(
        zipEntry(path, "content.xml"),
        ["table:table-row"],
        ["table:table-cell"]
      );
    case "pptx":
      return pptxText(path);
    case "odp":
      return xmlText(
        zipEntry(path, "content.xml"),
        ["text:p", "draw:page"],
        ["text:line-break", "text:tab"]
      );
    case "doc":
    case "rtf":
      if (tools.textutil) {
        return run([tools.textutil, "-convert", "txt", "-stdout", path]).then(
          decode
        );
      }
      if (extension === "rtf") {
        return rtfText(await Bun.file(path).text());
      }
      throw new Error("legacy Word files need macOS");
    default:
      return Bun.file(path).text();
  }
}

function zipEntry(path: string, name: string): string {
  const entries = unzipSync(new Uint8Array(readFileSync(path)), {
    filter: (file) => file.name === name,
  });
  const entry = entries[name];
  if (!entry) {
    throw new Error(`no ${name} inside`);
  }
  return decode(entry);
}

function zipEntries(
  path: string,
  match: (name: string) => boolean
): Record<string, string> {
  const entries = unzipSync(new Uint8Array(readFileSync(path)), {
    filter: (file) => match(file.name),
  });
  return Object.fromEntries(
    Object.entries(entries).map(([name, bytes]) => [name, decode(bytes)])
  );
}

/** A sheet is its name, then one tab-separated line per row. */
function xlsxText(path: string): string {
  const files = zipEntries(
    path,
    (name) =>
      name === "xl/sharedStrings.xml" ||
      name === "xl/workbook.xml" ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
  );
  const shared = [
    ...(files["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((match) =>
    entities(
      [...match[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
        .map((text) => text[1])
        .join("")
    )
  );
  const names = [
    ...(files["xl/workbook.xml"] ?? "").matchAll(/<sheet [^>]*name="([^"]*)"/g),
  ].map((match) => entities(match[1]!));
  const sheets = Object.keys(files)
    .filter((name) => name.startsWith("xl/worksheets/"))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return sheets
    .map((name, index) => {
      const rows = [
        ...files[name]!.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g),
      ].map((row) =>
        [...row[1]!.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map(([, attributes, body = ""]) => {
            if (/t="s"/.test(attributes!)) {
              return shared[Number(body.match(/<v>([^<]*)<\/v>/)?.[1])] ?? "";
            }
            if (/t="inlineStr"/.test(attributes!)) {
              return entities(body.replace(/<[^>]+>/g, ""));
            }
            return entities(body.match(/<v>([^<]*)<\/v>/)?.[1] ?? "");
          })
          .join("\t")
      );
      return [names[index] ?? `Sheet ${index + 1}`, ...rows].join("\n");
    })
    .join("\n\n");
}

/** A slide is its text, then its speaker notes. */
function pptxText(path: string): string {
  const files = zipEntries(path, (name) =>
    /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(name)
  );
  const number = (name: string) => Number(name.match(/(\d+)\.xml$/)![1]);
  const slides = Object.keys(files)
    .filter((name) => name.startsWith("ppt/slides/"))
    .sort((a, b) => number(a) - number(b));
  return slides
    .map((name) => {
      const text = (xml: string) =>
        [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
          .map((p) =>
            entities(
              [...p[1]!.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
                .map((t) => t[1])
                .join("")
            )
          )
          .join("\n");
      const notes = files[`ppt/notesSlides/notesSlide${number(name)}.xml`];
      return [text(files[name]!), notes ? text(notes) : ""]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/** Word-processing XML: paragraph ends become new lines, breaks and tabs spaces, every other tag goes. */
function xmlText(
  xml: string,
  paragraphs: readonly string[],
  spaces: readonly string[]
): string {
  let text = xml;
  for (const tag of paragraphs) {
    text = text.replaceAll(`</${tag}>`, "\n");
  }
  for (const tag of spaces) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "g"), " ");
  }
  return entities(text.replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlText(html: string): string {
  return entities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h\d|tr|br)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .trim();
}

function rtfText(rtf: string): string {
  return rtf
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\{\\\*[^{}]*\}|\\[a-z]+-?\d* ?|[{}]/gi, "")
    .trim();
}

function entities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, number: string) =>
      String.fromCodePoint(Number(number))
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// PDF: one segment per page; a page without enough text is rendered and embedded as a picture.

async function pdfSegments(path: string): Promise<Extraction> {
  const document = await getDocumentProxy(
    new Uint8Array(await Bun.file(path).arrayBuffer())
  );
  const { info } = await getMeta(document).catch(() => ({
    info: {} as Record<string, unknown>,
  }));
  const { text: pages } = await extractText(document, { mergePages: false });
  const segments: ExtractedSegment[] = [];
  let skippedScans = 0;
  for (const [index, raw] of pages.entries()) {
    const page = index + 1;
    const text = raw.replace(/[ \t]+/g, " ").trim();
    if (text.length >= PAGE_TEXT_MINIMUM) {
      // The vector sees the first 4000 characters; keywords see the whole page.
      segments.push({
        key: `page:${page}`,
        modality: "text",
        text: text.slice(0, PAGE_VECTOR_CHARACTERS),
        loc: page,
      });
      if (text.length > PAGE_VECTOR_CHARACTERS) {
        segments.push({
          key: `page:${page}:rest`,
          modality: "none",
          text: text.slice(PAGE_VECTOR_CHARACTERS),
          loc: page,
        });
      }
      continue;
    }
    // A short page may still be a few real sentences, such as a note or a letter: those keep a text vector.
    if (text) {
      segments.push({
        key: `page:${page}:text`,
        modality: isProse(text) ? "text" : "none",
        text,
        loc: page,
      });
    }
    const image = await renderPage(path, page);
    if (!image) {
      skippedScans += 1;
      continue;
    }
    segments.push({
      key: `page:${page}:image`,
      modality: "image",
      text: `Page ${page}`,
      media: image,
      loc: page,
    });
    const ocr = await recognize(image);
    if (ocr) {
      segments.push({
        key: `page:${page}:ocr`,
        modality: "none",
        text: ocr,
        loc: page,
      });
    }
  }
  const title =
    typeof info.Title === "string" && info.Title.trim()
      ? info.Title.trim()
      : undefined;
  return {
    title,
    segments,
    note: skippedScans
      ? `${skippedScans} scanned pages need poppler (pdftoppm)`
      : undefined,
  };
}

async function renderPage(
  path: string,
  page: number
): Promise<Uint8Array | null> {
  if (!tools.pdftoppm) {
    return null;
  }
  const directory = await mkdtemp(join(tmpdir(), "golem-page-"));
  try {
    const output = join(directory, "page");
    await run([
      tools.pdftoppm,
      "-f",
      String(page),
      "-l",
      String(page),
      "-scale-to",
      "1400",
      "-jpeg",
      "-singlefile",
      path,
      output,
    ]);
    return new Uint8Array(await Bun.file(`${output}.jpg`).arrayBuffer());
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Text in a picture, for keyword search only, when tesseract is installed. */
async function recognize(image: Uint8Array): Promise<string> {
  if (!tools.tesseract) {
    return "";
  }
  const directory = await mkdtemp(join(tmpdir(), "golem-ocr-"));
  try {
    const input = join(directory, "image.jpg");
    await Bun.write(input, image);
    return decode(
      await run([
        tools.tesseract,
        input,
        "stdout",
        "--psm",
        "3",
        "-l",
        await ocrLanguages(),
      ])
    ).trim();
  } catch {
    return "";
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

let languages: Promise<string> | undefined;

/** Every language tesseract has, such as "ces+eng"; reading with all of them handles mixed family papers. */
function ocrLanguages(): Promise<string> {
  languages ??= run([tools.tesseract!, "--list-langs"])
    .then((output) =>
      decode(output)
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => /^[a-z_]+$/.test(line) && line !== "osd")
    )
    .then((list) => list.join("+") || "eng")
    .catch(() => "eng");
  return languages;
}

// Pictures: the picture itself, at most 1024 pixels on its long side; screenshots also get OCR text.

async function imageSegments(path: string): Promise<Extraction> {
  const image = await jpeg(path);
  if (!image) {
    return { segments: [], note: "pictures need ffmpeg" };
  }
  const segments: ExtractedSegment[] = [
    { key: "image", modality: "image", text: "Picture", media: image },
  ];
  const name = basename(path).toLowerCase();
  if (
    SCREENSHOT_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    name.endsWith(".png")
  ) {
    const ocr = await recognize(image);
    if (ocr) {
      segments.push({ key: "ocr", modality: "none", text: ocr });
    }
  }
  return { segments };
}

/** The picture as a JPEG at most 1024 pixels long, with ffmpeg or sips; `null` without either. */
export async function jpeg(path: string): Promise<Uint8Array | null> {
  const fit =
    "scale='if(gt(iw,ih),min(1024,iw),-2)':'if(gt(iw,ih),-2,min(1024,ih))'";
  if (tools.ffmpeg) {
    const bytes = await run([
      tools.ffmpeg,
      "-v",
      "error",
      "-nostdin",
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      fit,
      "-q:v",
      "3",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ]).catch(() => null);
    if (bytes?.length) {
      return bytes;
    }
  }
  if (tools.sips) {
    const directory = await mkdtemp(join(tmpdir(), "golem-image-"));
    try {
      const output = join(directory, "image.jpg");
      await run([
        tools.sips,
        "-s",
        "format",
        "jpeg",
        "-Z",
        "1024",
        path,
        "--out",
        output,
      ]);
      return new Uint8Array(await Bun.file(output).arrayBuffer());
    } catch {
      return null;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return null;
}

// Audio: 30-second windows, 25 seconds apart, as 16 kHz mono WAV; silent windows are skipped.

async function audioSegments(
  path: string,
  prefix: string
): Promise<Extraction> {
  if (!tools.ffmpeg) {
    return { segments: [], note: "audio needs ffmpeg" };
  }
  const pcm = await run([
    tools.ffmpeg,
    "-v",
    "error",
    "-nostdin",
    "-i",
    path,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-t",
    String(AUDIO_MAX_SECONDS),
    "-f",
    "s16le",
    "pipe:1",
  ]).catch(() => null);
  if (!pcm?.length) {
    return { segments: [] };
  }
  const samples = new Int16Array(
    pcm.buffer,
    pcm.byteOffset,
    Math.floor(pcm.byteLength / 2)
  );
  const rate = 16_000;
  const segments: ExtractedSegment[] = [];
  for (
    let start = 0;
    start < samples.length;
    start += AUDIO_HOP_SECONDS * rate
  ) {
    const window = samples.subarray(start, start + AUDIO_WINDOW_SECONDS * rate);
    // A short tail is kept only when it is the whole recording or at least two seconds.
    if (start > 0 && window.length < 2 * rate) {
      break;
    }
    let sum = 0;
    for (const sample of window) {
      sum += (sample / 32_768) ** 2;
    }
    if (Math.sqrt(sum / window.length) <= SILENCE_RMS) {
      continue;
    }
    const from = start / rate;
    const to = (start + window.length) / rate;
    segments.push({
      key: `${prefix}audio:${from}`,
      modality: "audio",
      text: `${clock(from)}–${clock(to)}`,
      media: wav(window, rate),
      loc: from,
      locEnd: to,
    });
    if (start + window.length >= samples.length) {
      break;
    }
  }
  return { segments };
}

function wav(samples: Int16Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (const [index, character] of [...text].entries()) {
      view.setUint8(offset + index, character.charCodeAt(0));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.byteLength, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.byteLength, true);
  bytes.set(
    new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
    44
  );
  return bytes;
}

// Video: one frame every 3 seconds, kept only when it differs from the last kept frame, plus the soundtrack.

async function videoSegments(path: string): Promise<Extraction> {
  if (!tools.ffmpeg) {
    return { segments: [], note: "video needs ffmpeg" };
  }
  const sample = `fps=1/${VIDEO_FRAME_EVERY_SECONDS}`;
  const tiny = await run([
    tools.ffmpeg,
    "-v",
    "error",
    "-nostdin",
    "-i",
    path,
    "-an",
    "-vf",
    `${sample},scale=8:8,format=gray`,
    "-frames:v",
    String(VIDEO_MAX_FRAMES),
    "-f",
    "rawvideo",
    "pipe:1",
  ]).catch(() => null);
  const segments: ExtractedSegment[] = [];
  if (tiny?.length) {
    const kept = distinctFrames(tiny);
    const fit =
      "scale='if(gt(iw,ih),min(1024,iw),-2)':'if(gt(iw,ih),-2,min(1024,ih))'";
    const stream = await run([
      tools.ffmpeg,
      "-v",
      "error",
      "-nostdin",
      "-i",
      path,
      "-an",
      "-vf",
      `${sample},${fit}`,
      "-frames:v",
      String(VIDEO_MAX_FRAMES),
      "-q:v",
      "4",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ]).catch(() => null);
    const frames = stream ? splitJpegs(stream) : [];
    for (const frame of kept) {
      const image = frames[frame];
      if (!image) {
        continue;
      }
      const second = frame * VIDEO_FRAME_EVERY_SECONDS;
      segments.push({
        key: `frame:${second}`,
        modality: "image",
        text: `Frame at ${clock(second)}`,
        media: image,
        loc: second,
      });
    }
  }
  const sound = await audioSegments(path, "sound:");
  return { segments: [...segments, ...sound.segments] };
}

function splitJpegs(stream: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let start = -1;
  for (let index = 0; index < stream.length - 1; index += 1) {
    if (stream[index] !== 0xff) {
      continue;
    }
    if (stream[index + 1] === 0xd8 && start < 0) {
      start = index;
    } else if (stream[index + 1] === 0xd9 && start >= 0) {
      frames.push(stream.subarray(start, index + 2));
      start = -1;
    }
  }
  return frames;
}

/** An 8×8 average hash per frame; a frame within 4 bits of the last kept one shows the same shot. */
function distinctFrames(tiny: Uint8Array): number[] {
  const kept: number[] = [];
  let last: string | null = null;
  for (let frame = 0; frame * 64 + 64 <= tiny.length; frame += 1) {
    const pixels = [...tiny.subarray(frame * 64, frame * 64 + 64)];
    const mean = pixels.reduce((sum, value) => sum + value, 0) / 64;
    const hash = pixels.map((value) => (value > mean ? "1" : "0")).join("");
    if (last === null || differingBits(hash, last) > 4) {
      kept.push(frame);
      last = hash;
    }
  }
  return kept;
}

function differingBits(first: string, second: string): number {
  return [...first].filter((bit, index) => bit !== second[index]).length;
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

async function run(command: string[]): Promise<Uint8Array> {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${basename(command[0]!)} failed: ${error.slice(0, 200)}`);
  }
  return output;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

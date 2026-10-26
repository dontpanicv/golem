// How the file preview shows a file, from its name. Kept apart from the React code so that it can be tested alone.

export type FileKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "markdown"
  | "table"
  | "document"
  | "sheet"
  | "slides"
  | "archive"
  /** Shown as text if its bytes are text, else with no preview. */
  | "text";

/** The type of each picture the browser can show, so that a file the server sends as bytes still shows. */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  // A picture in an <img> cannot run its scripts.
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  heic: "image/heic",
};

const KINDS: Record<string, FileKind> = {
  pdf: "pdf",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  m4a: "audio",
  aac: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  flac: "audio",
  opus: "audio",
  md: "markdown",
  markdown: "markdown",
  csv: "table",
  tsv: "table",
  docx: "document",
  xlsx: "sheet",
  pptx: "slides",
  zip: "archive",
};

export function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileKind(name: string): FileKind {
  const ending = extension(name);
  return ending in IMAGE_TYPES ? "image" : (KINDS[ending] ?? "text");
}

export function imageType(name: string): string {
  return IMAGE_TYPES[extension(name)] ?? "application/octet-stream";
}

/** The rows of a CSV or TSV file, with quoted fields as RFC 4180 writes them. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  // A quoted field or a plain one, then what ends it: the delimiter, a line break, or the end of the text.
  const field = new RegExp(
    `(?:"((?:[^"]|"")*)"|([^"${delimiter}\\r\\n]*))(${delimiter}|\\r?\\n|\\r|$)`,
    "g"
  );
  const rows: string[][] = [];
  let row: string[] = [];
  for (const [, quoted, plain, end] of text.matchAll(field)) {
    row.push(quoted === undefined ? plain! : quoted.replaceAll('""', '"'));
    if (end !== delimiter) {
      rows.push(row);
      row = [];
    }
    if (end === "") {
      break;
    }
  }
  // A last line break leaves an empty row behind it.
  if (rows.at(-1)?.join("") === "" && text.endsWith("\n")) {
    rows.pop();
  }
  return rows;
}

/** The text of bytes that are UTF-8 text, or null for any other bytes. */
export function decodeText(bytes: ArrayBuffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

/** The file name of a Content-Disposition header, in its `filename*` or `filename` form. */
export function dispositionName(header: string | null): string | undefined {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    return decodeURIComponent(encoded);
  }
  return header?.match(/filename="?([^";]+)"?/i)?.[1];
}

import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Button, Empty } from "./components.tsx";
import {
  decodeText,
  dispositionName,
  extension,
  type FileKind,
  fileKind,
  imageType,
  parseDelimited,
} from "./file-kind.ts";
import { size } from "./format.ts";
import { Icon } from "./icon.tsx";

// The file preview, as Quick Look on a Mac: a click on a file shows it over the page, and Download saves it. Space
// or Escape closes it, and the arrow keys move to the file before or after. The code for Office files, archives, and
// highlighting loads only when such a file shows. The spec is in design/components.md.

export interface PreviewFile {
  readonly href: string;
  /** Unknown for a link that an agent wrote; the server's answer names the file. */
  readonly name?: string;
  readonly size?: number;
}

interface Shown {
  readonly files: readonly PreviewFile[];
  readonly index: number;
}

let shown: Shown | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function show(next: Shown | null): void {
  shown = next;
  for (const listener of listeners) {
    listener();
  }
}

export function previewFiles(files: readonly PreviewFile[], index = 0): void {
  show({ files, index });
}

/**
 * The props of a link to one of `files` that opens the preview. With a modifier key the browser opens the file itself.
 *
 * @example
 * <a className="file-chip" {...previewLink(files, index)}>{file.name}</a>
 */
export function previewLink(files: readonly PreviewFile[], index: number) {
  return {
    href: files[index]!.href,
    onClick: (event: MouseEvent) => {
      if (!(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
        event.preventDefault();
        previewFiles(files, index);
      }
    },
    // Space on a focused file opens it, as in the Finder.
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === " ") {
        event.preventDefault();
        previewFiles(files, index);
      }
    },
  };
}

/** The preview of the file that `previewFiles` shows. The app shows one, over every page. */
export function FilePreview() {
  const current = useSyncExternalStore(subscribe, () => shown);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    if (current && !element.open) {
      element.showModal();
      element.querySelector<HTMLElement>(".file-preview-body")?.focus();
    } else if (!current && element.open) {
      element.close();
    }
  }, [current]);
  const move = (step: number) => {
    if (current && current.files.length > 1) {
      const count = current.files.length;
      show({ ...current, index: (current.index + step + count) % count });
    }
  };
  const keys = (event: KeyboardEvent<HTMLDialogElement>) => {
    const target = event.target as Element;
    if (target.closest("input, textarea, video, audio")) {
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      move(event.key === "ArrowLeft" ? -1 : 1);
    } else if (event.key === " " && !target.closest("button, a")) {
      event.preventDefault();
      show(null);
    }
  };
  const file = current?.files[current.index];
  return (
    <dialog
      aria-label={file?.name ?? "File"}
      className="file-preview"
      onCancel={() => show(null)}
      onClick={(event) => event.target === event.currentTarget && show(null)}
      onClose={() => show(null)}
      onKeyDown={keys}
      ref={dialog}
    >
      {file ? (
        <FileView count={current.files.length} file={file} onMove={move} />
      ) : null}
    </dialog>
  );
}

/** The file once its name is known: the header and the file. */
function FileView({
  file,
  count,
  onMove,
}: {
  file: PreviewFile;
  count: number;
  onMove: (step: number) => void;
}) {
  const named = useNamed(file);
  return (
    <>
      <header className="file-preview-header">
        <h2>{named?.name}</h2>
        {named?.size === undefined ? null : (
          <span className="meta">{size(named.size)}</span>
        )}
        {count > 1 ? (
          <>
            <Button
              icon="back"
              label="Previous file"
              onClick={() => onMove(-1)}
              shortcut="←"
              size="icon"
              variant="ghost"
            />
            <Button
              icon="forward"
              label="Next file"
              onClick={() => onMove(1)}
              shortcut="→"
              size="icon"
              variant="ghost"
            />
          </>
        ) : null}
        <Button
          icon="download"
          label="Download"
          onClick={() => download(file.href, named?.name)}
          size="icon"
          variant="ghost"
        />
        <Button
          icon="close"
          label="Close"
          onClick={() => show(null)}
          shortcut="Space"
          size="icon"
          variant="ghost"
        />
      </header>
      <div className="file-preview-body" tabIndex={-1}>
        {named ? <Content file={named} key={named.href} /> : null}
      </div>
    </>
  );
}

/** `file` with its name, which the headers of the server's answer give when the link did not. */
function useNamed(
  file: PreviewFile
): (PreviewFile & { readonly name: string }) | undefined {
  const headers = useLoaded(
    async (signal) =>
      file.name === undefined
        ? (await fetch(file.href, { signal })).headers
        : undefined,
    file
  );
  if (file.name !== undefined) {
    return { ...file, name: file.name };
  }
  if (headers === undefined) {
    return;
  }
  if (headers === FAILED) {
    return { ...file, name: "File" };
  }
  return {
    ...file,
    name: dispositionName(headers.get("content-disposition")) ?? "File",
    size: Number(headers.get("content-length")) || undefined,
  };
}

/** Saves the file. A link on this site with `download` saves any kind of file, also one the browser can show. */
function download(href: string, name = ""): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
}

type Named = PreviewFile & { readonly name: string };

function Content({ file }: { file: Named }) {
  const kind = fileKind(file.name);
  if (kind === "pdf") {
    // The browser's own viewer, with its pages, zoom, and search.
    return (
      <iframe
        className="file-preview-frame"
        src={file.href}
        title={file.name}
      />
    );
  }
  if (kind === "video") {
    return (
      // biome-ignore lint/a11y/useMediaCaption: a person's own video has no captions
      <video autoPlay className="file-preview-media" controls src={file.href} />
    );
  }
  if (kind === "audio") {
    return (
      // biome-ignore lint/a11y/useMediaCaption: the same
      <audio autoPlay controls src={file.href} />
    );
  }
  return <Fetched file={file} kind={kind} />;
}

/** Files larger than this download only when asked, as the preview reads all of a file first. */
const FETCH_LIMIT = 20 * 1024 * 1024;

/** A file that shows from its bytes. */
function Fetched({ file, kind }: { file: Named; kind: FileKind }) {
  const bytes = useLoaded(async (signal) => {
    const response = await fetch(file.href, { signal });
    if (
      !response.ok ||
      Number(response.headers.get("content-length")) > FETCH_LIMIT
    ) {
      throw new Error("No preview");
    }
    return response.arrayBuffer();
  }, file.href);
  if (bytes === undefined) {
    return null;
  }
  if (bytes === FAILED) {
    return <NoPreview file={file} />;
  }
  if (kind === "image") {
    return <Picture bytes={bytes} name={file.name} />;
  }
  if (kind === "document") {
    return <Document bytes={bytes} file={file} />;
  }
  if (kind === "sheet") {
    return <Sheet bytes={bytes} file={file} />;
  }
  if (kind === "slides") {
    return <Slides bytes={bytes} file={file} />;
  }
  if (kind === "archive") {
    return <Archive bytes={bytes} file={file} />;
  }
  const text = decodeText(bytes);
  if (text === null) {
    return <NoPreview file={file} />;
  }
  if (kind === "markdown") {
    return (
      <div className="file-preview-page prose">
        <ReactMarkdown
          components={{ a: ExternalLink }}
          rehypePlugins={[rehypeRaw, rehypeSanitize]}
          remarkPlugins={[remarkGfm]}
        >
          {text}
        </ReactMarkdown>
      </div>
    );
  }
  if (kind === "table") {
    return (
      <Table
        rows={parseDelimited(text, extension(file.name) === "tsv" ? "\t" : ",")}
      />
    );
  }
  return <Code language={extension(file.name)} text={text} />;
}

function NoPreview({ file }: { file: Named }) {
  return (
    <div className="file-preview-none">
      <Empty icon="file" title="No preview" />
      <Button
        icon="download"
        label="Download"
        onClick={() => download(file.href, file.name)}
        variant="primary"
      />
    </div>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  return (
    <a href={href} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  );
}

function Picture({ bytes, name }: { bytes: ArrayBuffer; name: string }) {
  // The server sends a picture it cannot show safely, such as an SVG, as bytes; a typed blob shows it.
  const [url] = useState(() =>
    URL.createObjectURL(new Blob([bytes], { type: imageType(name) }))
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  // biome-ignore lint/correctness/useImageSize: a file's picture has no known size
  return <img alt={name} className="file-preview-media" src={url} />;
}

/** Code longer than this shows without colors, as highlighting it would hold up the page. */
const HIGHLIGHT_LIMIT = 200_000;

function Code({ text, language }: { text: string; language: string }) {
  const html = useLoaded(async () => {
    if (text.length > HIGHLIGHT_LIMIT) {
      return;
    }
    const { bundledLanguages, codeToHtml } = await import("shiki");
    if (!(language in bundledLanguages)) {
      return;
    }
    return codeToHtml(text, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light-dark()",
      transformers: [
        {
          // The preview's own background and text color show behind the code.
          pre(node) {
            node.properties.style = undefined;
          },
        },
      ],
    });
  }, text);
  if (typeof html === "string") {
    return (
      <div
        className="file-preview-code"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki escapes the code it colors
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <div className="file-preview-code">
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** Rows past this do not show, so that a large sheet does not hold up the page. */
// shortcut: a sheet shows its first 5,000 rows; render rows as they scroll into view if families keep larger sheets.
const ROW_LIMIT = 5000;

function Table({ rows }: { rows: readonly (readonly unknown[])[] }) {
  const [head, ...body] = rows;
  return (
    <div className="file-preview-table">
      <table>
        {head ? (
          <thead>
            <tr>
              {head.map((cell, column) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity but their place
                <th key={column}>{cellText(cell)}</th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {body.slice(0, ROW_LIMIT).map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same
            <tr key={index}>
              {row.map((cell, column) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the same
                <td key={column}>{cellText(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cellText(cell: unknown): string {
  if (cell instanceof Date) {
    return cell.toLocaleDateString();
  }
  return cell === null || cell === undefined ? "" : String(cell);
}

/**
 * An empty page for a Word document. Nothing in the frame can run, and its links open in a new tab. Its color scheme
 * is the page's, so its pages show on the preview's background.
 */
const DOCUMENT_FRAME =
  '<!doctype html><meta name="color-scheme" content="light dark"><base target="_blank"><style>body{margin:0}.docx-wrapper{min-height:100vh;box-sizing:border-box;background:transparent!important}</style><div id="styles"></div><div id="document"></div>';

function Document({ bytes, file }: { bytes: ArrayBuffer; file: Named }) {
  const [failed, setFailed] = useState(false);
  const render = async (frame: HTMLIFrameElement) => {
    const page = frame.contentDocument!;
    try {
      const { renderAsync } = await import("docx-preview");
      // docx-preview empties both containers first, so they are not the page's own head and body.
      await renderAsync(
        bytes,
        page.getElementById("document")!,
        page.getElementById("styles")!,
        {
          renderAltChunks: false,
        }
      );
    } catch {
      setFailed(true);
    }
  };
  if (failed) {
    return <NoPreview file={file} />;
  }
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the frame's load is no person's action
    <iframe
      className="file-preview-frame"
      onLoad={(event) => render(event.currentTarget)}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={DOCUMENT_FRAME}
      title={file.name}
    />
  );
}

function Sheet({ bytes, file }: { bytes: ArrayBuffer; file: Named }) {
  const sheets = useLoaded(async () => {
    const { default: readSheets } = await import("read-excel-file/browser");
    return readSheets(new Blob([bytes]));
  }, bytes);
  const [index, setIndex] = useState(0);
  if (sheets === undefined) {
    return null;
  }
  if (sheets === FAILED) {
    return <NoPreview file={file} />;
  }
  return (
    <div className="file-preview-sheet">
      {sheets.length > 1 ? (
        <div className="tabs" role="tablist">
          {sheets.map((sheet, position) => (
            <button
              aria-selected={position === index}
              className="tab"
              key={sheet.sheet}
              onClick={() => setIndex(position)}
              role="tab"
              type="button"
            >
              {sheet.sheet}
            </button>
          ))}
        </div>
      ) : null}
      <Table rows={sheets[index]!.data} />
    </div>
  );
}

/** The width in CSS pixels that each slide renders at; the page scales it down to fit. */
const SLIDE_WIDTH = 1280;

function Slides({ bytes, file }: { bytes: ArrayBuffer; file: Named }) {
  const list = useRef<HTMLDivElement>(null);
  const slides = useLoaded(async (signal) => {
    const { default: JSZip } = await import("jszip");
    // PptxViewJS loads JSZip from a CDN when it finds none on the page.
    (globalThis as { JSZip?: unknown }).JSZip ??= JSZip;
    const presentation = await (await JSZip.loadAsync(bytes))
      .file("ppt/presentation.xml")
      ?.async("text");
    const [, width = "16", height = "9"] =
      presentation?.match(/<p:sldSz[^>]*?cx="(\d+)"[^>]*?cy="(\d+)"/) ?? [];
    const { PPTXViewer } = await import("pptxviewjs");
    const viewer = new PPTXViewer({ slideSizeMode: "fit" });
    await viewer.loadFile(bytes);
    const canvases: HTMLCanvasElement[] = [];
    for (
      let index = 0;
      index < viewer.getSlideCount() && !signal.aborted;
      index += 1
    ) {
      // PptxViewJS draws at the canvas's style size, sharp for the screen; the page sizes it after.
      const canvas = document.createElement("canvas");
      canvas.style.width = `${SLIDE_WIDTH}px`;
      canvas.style.height = `${(SLIDE_WIDTH * Number(height)) / Number(width)}px`;
      await viewer.renderSlide(index, canvas);
      canvas.removeAttribute("style");
      canvases.push(canvas);
    }
    viewer.destroy();
    return canvases;
  }, bytes);
  useEffect(() => {
    if (Array.isArray(slides)) {
      list.current?.replaceChildren(...slides);
    }
  }, [slides]);
  if (slides === FAILED) {
    return <NoPreview file={file} />;
  }
  return <div className="file-preview-slides" ref={list} />;
}

function Archive({ bytes, file }: { bytes: ArrayBuffer; file: Named }) {
  const entries = useLoaded(async () => {
    const { unzipSync } = await import("fflate");
    const found: { name: string; originalSize: number }[] = [];
    // The filter sees each entry and takes none, so nothing unpacks.
    unzipSync(new Uint8Array(bytes), {
      filter: (entry) => {
        if (!entry.name.endsWith("/")) {
          found.push(entry);
        }
        return false;
      },
    });
    return found;
  }, bytes);
  if (entries === undefined) {
    return null;
  }
  if (entries === FAILED) {
    return <NoPreview file={file} />;
  }
  return (
    <div className="file-preview-page list">
      {entries.map((entry) => (
        <div className="list-row" key={entry.name}>
          <Icon name="file" />
          <span className="name">{entry.name}</span>
          <span className="meta">{size(entry.originalSize)}</span>
        </div>
      ))}
    </div>
  );
}

const FAILED = Symbol("failed");

/** What `load` gives, `FAILED` if it throws, or undefined until then. A new `key` loads again. */
function useLoaded<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: unknown
): T | typeof FAILED | undefined {
  const [state, setState] = useState<{
    key: unknown;
    value: T | typeof FAILED;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for what `load` reads
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (value) => controller.signal.aborted || setState({ key, value }),
      () => controller.signal.aborted || setState({ key, value: FAILED })
    );
    return () => controller.abort();
  }, [key]);
  return state && state.key === key ? state.value : undefined;
}

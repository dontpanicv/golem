import { resolve, sep } from "node:path";
import { HttpError } from "../platform/errors.ts";
import type { RouteInput } from "./http.ts";

const publicDirectory = resolve(import.meta.dir, "../../public");
/** The web app that `bun run build` makes from `web/`. */
const appDirectory = resolve(import.meta.dir, "../../dist/web");

/**
 * What the app's page may load: its own scripts, and pictures, frames, and data only from Golem, so a picture or a
 * link in what an agent writes cannot send data to another site. Shiki compiles its grammars to WebAssembly; the
 * previews and Radix add inline styles.
 */
const APP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The web app's page for every path the app routes in the browser. It has no data: the app loads it from the JSON API
 * and keeps it in the browser.
 */
export async function appPage(): Promise<Response> {
  const page = Bun.file(resolve(appDirectory, "index.html"));
  if (!(await page.exists())) {
    return new Response("Run `bun run build` to make the web app", {
      status: 503,
    });
  }
  return new Response(page, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "content-security-policy": APP_POLICY,
    },
  });
}

/** A file of the built web app. Its name has a hash of its content, so browsers keep it for good. */
export async function appFile(request: Request): Promise<Response> {
  return fileIn(appDirectory, request, "/app/", true);
}

/** Serves a file from `public/`, such as the icons; paths that leave it are not found. Browsers check it every time. */
export async function asset(request: Request): Promise<Response> {
  return fileIn(publicDirectory, request, "/assets/", false);
}

async function fileIn(
  directory: string,
  request: Request,
  prefix: string,
  immutable: boolean
): Promise<Response> {
  const name = decodeURIComponent(
    new URL(request.url).pathname.slice(prefix.length)
  );
  const path = resolve(directory, name);
  const file = Bun.file(path);
  if (!(path.startsWith(directory + sep) && (await file.exists()))) {
    return new Response("Not found", { status: 404 });
  }
  const headers = {
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
  if (immutable && compressible(request, path)) {
    return new Response(await gzipped(path), {
      headers: {
        ...headers,
        "content-type": file.type,
        "content-encoding": "gzip",
        vary: "accept-encoding",
      },
    });
  }
  return new Response(file, { headers });
}

/** The app's scripts and styles shrink to a third with gzip, which matters most on a slow connection. */
function compressible(request: Request, path: string): boolean {
  return (
    /\.(js|css)$/.test(path) &&
    /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")
  );
}

/** A built file never changes under its name, so it is compressed once. */
const compressed = new Map<string, Promise<Uint8Array>>();

function gzipped(path: string): Promise<Uint8Array> {
  let bytes = compressed.get(path);
  if (!bytes) {
    bytes = Bun.file(path)
      .bytes()
      .then((content) => Bun.gzipSync(content));
    compressed.set(path, bytes);
  }
  return bytes;
}

/**
 * Requests that change something must come from this site: browsers send `Origin` on them. Compare with `base_url`,
 * not the request URL: behind a TLS proxy the request arrives as `http` while the browser sends an `https` origin.
 * The iOS app sends no `Origin`.
 */
export function rejectCrossOrigin({ app, request }: RouteInput): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(app.config.baseUrl).origin) {
    throw new HttpError(403, "Cross-site request");
  }
}

/**
 * The body of a request as text, or `413` when it is over `limit` bytes. It counts the bytes as they come, so a body
 * without a true `content-length` stops at the limit too.
 */
export async function readText(
  request: Request,
  limit: number
): Promise<string> {
  const tooLarge = new HttpError(413, "The request is too large");
  if (Number(request.headers.get("content-length")) > limit) {
    throw tooLarge;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) {
      throw tooLarge;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The text fields of a form, and its files; a file field with nothing chosen sends no file. */
export async function readForm(request: Request): Promise<{
  fields: Record<string, string | undefined>;
  files: File[];
}> {
  const data = await request.formData().catch(() => new FormData());
  const entries = [...data.entries()];
  return {
    fields: Object.fromEntries(
      entries.map(([key, value]) => [
        key,
        typeof value === "string" ? value : undefined,
      ])
    ),
    files: entries.flatMap(([, value]) =>
      // Browsers send an empty file field as a part with `filename=""`, which Bun reads as a file without a name.
      typeof value !== "string" && value.name ? [value] : []
    ),
  };
}

export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

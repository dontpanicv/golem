import { resolve, sep } from "node:path";
import { HttpError } from "../platform/errors.ts";
import type { Toast } from "../platform/ui/components.ts";
import {
  type AuthedInput,
  type Handler,
  type RouteInput,
  signedIn,
} from "./http.ts";

const publicDirectory = resolve(import.meta.dir, "../../public");

export type FormInput = RouteInput & {
  readonly fields: Record<string, string | undefined>;
};
export type AuthedFormInput = AuthedInput & {
  readonly fields: Record<string, string | undefined>;
  /** The files of a `multipart/form-data` form. */
  readonly files: readonly File[];
};

/** A page for signed-in people; others go to the login page. Not found errors render as 404. */
export function page(
  handler: (input: AuthedInput) => Promise<Response>
): Handler {
  return signedIn(
    async (input) => {
      try {
        return await handler(input);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          return new Response("Not found", { status: 404 });
        }
        throw error;
      }
    },
    () => redirect("/login")
  );
}

/** A form post by a signed-in person: redirects to the returned path, or back to `back` with the error. */
export function action(
  back: string | ((input: { params: RouteInput["params"] }) => string),
  handler: (input: AuthedFormInput) => Promise<string>
): Handler {
  return page(async (input) => {
    rejectCrossOrigin(input);
    const { fields, files } = await readForm(input.request);
    try {
      return redirect(await handler({ ...input, fields, files }));
    } catch (error) {
      if (error instanceof HttpError && error.status !== 404) {
        return redirect(
          withError(
            typeof back === "string" ? back : back(input),
            error.message
          )
        );
      }
      throw error;
    }
  });
}

/** A form post before sign-in: errors from better-auth go back to `back`. */
export function form(
  handler: (input: FormInput) => Promise<Response>,
  back: string
): Handler {
  return async (input) => {
    rejectCrossOrigin(input);
    const { fields } = await readForm(input.request);
    try {
      return await handler({ ...input, fields });
    } catch (error) {
      const message =
        (error as { body?: { message?: string } }).body?.message ??
        (error as Error).message;
      return redirect(withError(back, message));
    }
  };
}

/**
 * Form posts must come from this site: browsers send `Origin` on cross-site posts. Compare with `base_url`, not the
 * request URL: behind a TLS proxy the request arrives as `http` while the browser sends an `https` origin.
 */
export function rejectCrossOrigin({ app, request }: RouteInput): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(app.config.baseUrl).origin) {
    throw new HttpError(403, "Cross-site request");
  }
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

/** The toast a redirect asked for with `?error=` or `?notice=`. Failed Google sign-ins also send `error_description`. */
export function toastOf(request: Request): Toast {
  const params = new URL(request.url).searchParams;
  const error = params.get("error_description") ?? params.get("error");
  if (error) {
    return { tone: "error", text: error };
  }
  const notice = params.get("notice");
  return notice ? { tone: "success", text: notice } : null;
}

export function withNotice(path: string, message: string): string {
  return `${path}?notice=${encodeURIComponent(message)}`;
}

export function withError(path: string, message: string): string {
  return `${path}?error=${encodeURIComponent(message)}`;
}

export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Serves a file from `public/`; paths that leave it are not found. */
export async function asset(request: Request): Promise<Response> {
  const path = resolve(
    publicDirectory,
    decodeURIComponent(new URL(request.url).pathname.slice("/assets/".length))
  );
  const file = Bun.file(path);
  if (!(path.startsWith(publicDirectory + sep) && (await file.exists()))) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(file);
}

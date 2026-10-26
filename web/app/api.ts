// The JSON API of docs/api.md, which the iOS app uses too. The session cookie signs the web app in.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  /** A JSON body, or a form with files. */
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * Calls `/api/v1<path>`. A `401` sends the person to sign in; other errors throw with the server's message.
 *
 * @example
 * const { user, workspaces } = await request<Me>("/me");
 */
export async function request<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  // A form sends itself with its own content type; anything else goes as JSON.
  const json = !(
    options.body === undefined || options.body instanceof FormData
  );
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? "GET",
    headers: json ? { "content-type": "application/json" } : undefined,
    body: json ? JSON.stringify(options.body) : (options.body as FormData),
    signal: options.signal,
  });
  if (response.status === 401) {
    signIn();
    throw new ApiError(401, "Sign in first");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(
      response.status,
      body?.error ?? "The request failed. Try again."
    );
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** The address of a file of the workspace, in a channel or its own. */
export function fileHref(workspaceId: string, fileId: string): string {
  return `/api/v1/workspaces/${workspaceId}/files/${fileId}`;
}

/** Opens the sign-in page, which comes back to this page after sign-in. */
export function signIn(): void {
  if (location.pathname !== "/login") {
    location.assign(
      `/login?next=${encodeURIComponent(location.pathname + location.search)}`
    );
  }
}

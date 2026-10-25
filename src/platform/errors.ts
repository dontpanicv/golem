/** An error with the HTTP status that the routes answer with; services throw it for bad input or missing access. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

/** Not found, also for things that exist but belong to a workspace the person is not a member of. */
export const notFound = () => new HttpError(404, "Not found");

/** The trimmed text, or a 400 that names the field. */
export function required(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new HttpError(400, `${field} is required`);
  }
  return text;
}

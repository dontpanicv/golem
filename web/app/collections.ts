/**
 * One collection for each key, such as a workspace id, made the first time a page asks for it and kept while the app
 * runs, so every page that shows the same rows shares them.
 *
 * @example
 * const threadsOf = keyed((workspaceId: string) => createCollection(...));
 * threadsOf(workspaceId).update(threadId, (draft) => { draft.settledAt = Date.now(); });
 */
export function keyed<Value>(
  make: (key: string) => Value
): (key: string) => Value {
  const made = new Map<string, Value>();
  return (key) => {
    let value = made.get(key);
    if (value === undefined) {
      value = make(key);
      made.set(key, value);
    }
    return value;
  };
}

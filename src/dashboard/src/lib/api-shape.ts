/**
 * Coercions for API payloads whose shape is not guaranteed (DROP-237).
 *
 * WHY THIS EXISTS, because a one-line `?? []` looks like it already does the
 * job and does not.
 *
 * `AppDetailPage` read the secrets response as `json.data.keys ?? []` and
 * passed the result straight to `setEnvVars`. When `data` came back as an
 * ARRAY rather than the expected `{ keys: [...] }`, `data.keys` is not
 * undefined: it is `Array.prototype.keys`, a FUNCTION. `??` therefore never
 * fires, React sees a function passed to a state setter, treats it as an
 * UPDATER, and calls it unbound:
 *
 *     TypeError: Cannot convert undefined or null to object
 *         at basicStateReducer (react-dom)
 *
 * The whole page was replaced by the error boundary at mount. Not the tab, not
 * the card: the header, the tabs and every action button went with it.
 *
 * The general hazard is reading a property off a JSON value when that property
 * name collides with something on `Array.prototype` or `Object.prototype` —
 * `keys`, `values`, `entries`, `map`, `find`, `constructor`. JSON itself can
 * never contain a function, so the function can only have come from a
 * prototype, which is exactly the case `??` and `||` both fail to catch.
 *
 * Checking the type you actually want is the fix, not a longer default chain.
 */

/** The value at `key`, but only if it is genuinely an array of strings. */
export function asStringArray(value: unknown, key: string): string[] {
  if (value === null || typeof value !== 'object') return [];
  const found = (value as Record<string, unknown>)[key];
  if (!Array.isArray(found)) return [];
  return found.filter((v): v is string => typeof v === 'string');
}

/** `value` itself, but only if it is genuinely an array. */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * `value` if it is genuinely an array, otherwise `fallback` — returned BY
 * IDENTITY, not copied. The polled hooks hand out one shared empty array so
 * `useMemo([apps])` in AppsPage does not re-run on every poll; a fresh `[]`
 * here would defeat that, which is why this exists alongside `asArray`.
 */
export function asArrayOr<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}

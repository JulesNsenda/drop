/**
 * Exhaustiveness guard for a closed union. Put it in the final `else` of an
 * `if / else if` chain over a discriminant, so a new member is a COMPILE error
 * at every such site instead of silently taking whichever branch happened to
 * be written last (a bare `else` is how a third attachable service would have
 * been handled as "the other one").
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${String(value)}`);
}

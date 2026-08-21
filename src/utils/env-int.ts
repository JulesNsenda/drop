/**
 * Shared positive-integer env-var parser.
 *
 * FAIL-CLOSED BY DESIGN: unset, empty, non-numeric, fractional, zero, or
 * negative all fall back to the caller's default — never to "no limit" or
 * "disabled". A guardrail/timeout env whose value is a typo (`'10O0'`,
 * `'-5'`, `'off'`) must not silently mean "unbounded"; it must behave as if
 * the operator had never set it.
 *
 * Callers that want a deliberate opt-out (e.g. an explicit `'0'` meaning
 * "keep forever") must recognise that literal themselves BEFORE calling this
 * helper — this helper's own contract is strictly positive-integer-or-default,
 * so it cannot express "0 is valid and means something else" without
 * silently reopening the same fail-open hole for every other caller.
 */
export function parsePositiveIntEnv(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

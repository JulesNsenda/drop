/**
 * parsePositiveIntEnv — the shared fail-closed env-int parser.
 *
 * The property worth pinning: nothing but a genuine positive integer ever
 * escapes to the caller. Every other shape (unset, blank, garbage, zero,
 * negative, fractional) resolves to the given default.
 */
import { parsePositiveIntEnv } from './env-int';

describe('parsePositiveIntEnv', () => {
  it('returns the default when unset', () => {
    expect(parsePositiveIntEnv(undefined, 42)).toBe(42);
  });

  it('returns the default for an empty string', () => {
    expect(parsePositiveIntEnv('', 42)).toBe(42);
  });

  it('returns the default for a blank (whitespace-only) string', () => {
    expect(parsePositiveIntEnv('   ', 42)).toBe(42);
  });

  it('returns the default for non-numeric garbage rather than throwing', () => {
    expect(parsePositiveIntEnv('not-a-number', 42)).toBe(42);
    expect(parsePositiveIntEnv('10O0', 42)).toBe(42);
    expect(parsePositiveIntEnv('off', 42)).toBe(42);
  });

  it('returns the default for zero — a positive-int parser is not a "0 disables" parser', () => {
    expect(parsePositiveIntEnv('0', 42)).toBe(42);
  });

  it('returns the default for a negative value', () => {
    expect(parsePositiveIntEnv('-5', 42)).toBe(42);
  });

  it('returns the default for a fractional value', () => {
    expect(parsePositiveIntEnv('1.5', 42)).toBe(42);
  });

  it('parses a valid positive integer', () => {
    expect(parsePositiveIntEnv('600000', 5)).toBe(600000);
  });

  it('tolerates surrounding whitespace on a valid value', () => {
    expect(parsePositiveIntEnv('  10  ', 5)).toBe(10);
  });
});

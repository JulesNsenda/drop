import { asStringArray, asArray } from './api-shape';

/**
 * DROP-237. The case that mattered is `asStringArray([], 'keys')`.
 *
 * `[].keys` is `Array.prototype.keys` — a function, not undefined — so the
 * original `json.data.keys ?? []` passed a FUNCTION to `setEnvVars`. React
 * treats a function given to a state setter as an updater and calls it
 * unbound, throwing `Cannot convert undefined or null to object` from
 * `basicStateReducer` and white-screening the whole page at mount.
 *
 * Every other shape below already worked. This one did not, and it is the only
 * one a `?? []` cannot catch, because the value is neither null nor undefined.
 */
describe('asStringArray', () => {
  it('returns the array when the shape is what we expect', () => {
    expect(asStringArray({ keys: ['API_KEY', 'DATABASE_URL'] }, 'keys')).toEqual([
      'API_KEY',
      'DATABASE_URL',
    ]);
  });

  it('THE REGRESSION: an array payload must not leak Array.prototype.keys', () => {
    // `[].keys` is a function. A `?? []` default does not fire on it.
    expect(typeof ([] as unknown as Record<string, unknown>).keys).toBe('function');
    const out = asStringArray([], 'keys');
    expect(out).toEqual([]);
    expect(typeof out).not.toBe('function');
    expect(Array.isArray(out)).toBe(true);
  });

  it('never returns a function for any prototype-colliding key', () => {
    for (const key of ['keys', 'values', 'entries', 'map', 'find', 'constructor', 'toString']) {
      expect(Array.isArray(asStringArray([], key))).toBe(true);
      expect(Array.isArray(asStringArray({}, key))).toBe(true);
    }
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['a number', 7],
    ['an empty object', {}],
    ['the key holding a non-array', { keys: 'API_KEY' }],
  ])('returns [] for %s', (_label, input) => {
    expect(asStringArray(input, 'keys')).toEqual([]);
  });

  it('drops non-string members rather than passing them through', () => {
    expect(asStringArray({ keys: ['OK', 3, null, 'FINE'] }, 'keys')).toEqual(['OK', 'FINE']);
  });
});

describe('asArray', () => {
  it('passes an array through', () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an object', { a: 1 }],
    ['a string', 'no'],
  ])('returns [] for %s', (_label, input) => {
    expect(asArray(input)).toEqual([]);
  });
});

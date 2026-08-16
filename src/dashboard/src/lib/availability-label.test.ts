import { describeAvailability } from './availability-label';

describe('describeAvailability', () => {
  it('marks an available extension addable, with a positive tone', () => {
    const result = describeAvailability({ availability: 'available' });
    expect(result.canAdd).toBe(true);
    expect(result.tone).toBe('ok');
    expect(result.label).toBe('Available');
  });

  it('marks postgres-not-ready as not addable, with a neutral tone', () => {
    const result = describeAvailability({
      availability: 'unavailable',
      unavailableReason: 'postgres-not-ready',
    });
    expect(result.canAdd).toBe(false);
    expect(result.tone).toBe('neutral');
  });

  it('marks redis-not-ready as not addable, with a neutral tone', () => {
    const result = describeAvailability({
      availability: 'unavailable',
      unavailableReason: 'redis-not-ready',
    });
    expect(result.canAdd).toBe(false);
    expect(result.tone).toBe('neutral');
  });

  it('gives every unavailable reason distinct copy', () => {
    const postgres = describeAvailability({
      availability: 'unavailable',
      unavailableReason: 'postgres-not-ready',
    });
    const redis = describeAvailability({
      availability: 'unavailable',
      unavailableReason: 'redis-not-ready',
    });
    expect(postgres.detail).not.toBe(redis.detail);
  });

  /**
   * The honesty requirement the plan calls out by name: a route cannot tell
   * "managed Redis is disabled in this platform's config" apart from "it
   * failed to start" (`ApiServerConfig` exposes neither `isolation` nor
   * `enableRedis`, and the platform nulls the server and provisioner together
   * on a soft failure). The copy must not claim one cause over the other, and
   * it must not read as if the reader did something wrong.
   */
  it('states both the disabled and the failed-to-start possibility for redis, without blaming the reader', () => {
    const { detail } = describeAvailability({
      availability: 'unavailable',
      unavailableReason: 'redis-not-ready',
    });

    expect(detail.toLowerCase()).toMatch(/turned off|disabled|not enabled/);
    expect(detail.toLowerCase()).toMatch(/failed to start/);
    // Points at an operator action rather than the reader.
    expect(detail.toLowerCase()).toContain('operator');
    expect(detail.toLowerCase()).not.toMatch(/you (did|forgot|need to)/);
  });

  it('describes postgres-not-ready as the database layer not having booted, and points at an operator', () => {
    const { detail } = describeAvailability({
      availability: 'unavailable',
      unavailableReason: 'postgres-not-ready',
    });

    expect(detail.toLowerCase()).toMatch(/starting|start|boot/);
    expect(detail.toLowerCase()).toContain('operator');
  });

  it('never emits a host path, a binary path, or a raw error string', () => {
    const reasons = ['postgres-not-ready', 'redis-not-ready'] as const;
    for (const reason of reasons) {
      const { detail } = describeAvailability({ availability: 'unavailable', unavailableReason: reason });
      expect(detail).not.toMatch(/[\\/](usr|var|home|bin|opt|Users|drop-svc)[\\/]/i);
      expect(detail).not.toMatch(/\.(exe|sh|log)\b/i);
      expect(detail).not.toMatch(/Error:|Exception|ECONNREFUSED|ENOENT/);
    }
  });

  it('falls back to a generic, still-operator-directed message when no reason is given for an unavailable extension', () => {
    const result = describeAvailability({ availability: 'unavailable' });
    expect(result.canAdd).toBe(false);
    expect(result.tone).toBe('neutral');
    expect(result.detail.toLowerCase()).toContain('operator');
  });

  // The reason arrives over the wire, and the dashboard is a separate package:
  // a browser can hold a cached bundle older than the API serving it, so a
  // reason added to the server's union after this build is a real input, not a
  // hypothetical. Indexing the copy table directly would throw on `.detail`
  // and blank the whole card. The cast is the point of the test — it
  // reproduces exactly what an older bundle receives.
  it('falls back instead of throwing when the server sends a reason this build does not know', () => {
    const result = describeAvailability({
      availability: 'unavailable',
      unavailableReason: 'mysql-not-ready' as never,
    });
    expect(result.canAdd).toBe(false);
    expect(result.detail).toBe(
      "This isn't available on this platform right now. Ask an operator to check."
    );
  });
});

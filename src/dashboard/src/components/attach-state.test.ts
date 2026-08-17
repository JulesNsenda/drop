import {
  describeAttachCard,
  describeAttachRefusal,
  formatQuotaUsage,
  type AttachCardInput,
  type QuotaState,
} from './attach-state';

const unconstrainedQuota: QuotaState = { used: 0, limit: 0, constrained: false };

const input = (over: Partial<AttachCardInput> = {}): AttachCardInput => ({
  provisioned: false,
  role: 'user',
  quota: unconstrainedQuota,
  ...over,
});

describe('describeAttachCard', () => {
  it('marks a provisioned service attached, with no attach control offered', () => {
    const view = describeAttachCard(input({ provisioned: true }));
    expect(view.attached).toBe(true);
    expect(view.canAttach).toBe(false);
  });

  // The honesty requirement stated plainly: an app that already has Postgres
  // provisioned must not offer Attach for it, no matter what role or quota
  // say — those only matter for a control that could otherwise work.
  it('never offers attach for a provisioned service even with admin role and headroom', () => {
    const view = describeAttachCard(
      input({
        provisioned: true,
        role: 'admin',
        quota: { used: 0, limit: 5, constrained: true },
      })
    );
    expect(view.attached).toBe(true);
    expect(view.canAttach).toBe(false);
  });

  it('offers attach for an unprovisioned service with no explicit intent, headroom and a non-readonly role', () => {
    const view = describeAttachCard(input());
    expect(view.attached).toBe(false);
    expect(view.canAttach).toBe(true);
    expect(view.disabledReason).toBeUndefined();
    expect(view.previouslyDetached).toBe(false);
    expect(view.actionLabel).toBe('Attach');
  });

  // services[id] === 'detached' is a real state distinct from an app that
  // never had an explicit intent recorded — the card must be able to tell
  // them apart even though both currently render an enabled Attach control.
  it('distinguishes a previously-detached service from one that was never touched', () => {
    const untouched = describeAttachCard(input());
    const detached = describeAttachCard(input({ intent: 'detached' }));

    expect(untouched.previouslyDetached).toBe(false);
    expect(detached.previouslyDetached).toBe(true);
    expect(untouched.actionLabel).toBe('Attach');
    expect(detached.actionLabel).toBe('Re-attach');
    // Both are equally attachable — 'detached' does not block re-attaching.
    expect(untouched.canAttach).toBe(true);
    expect(detached.canAttach).toBe(true);
  });

  it('disables the control for a readonly role even with quota headroom', () => {
    const view = describeAttachCard(
      input({ role: 'readonly', quota: { used: 0, limit: 5, constrained: true } })
    );
    expect(view.attached).toBe(false);
    expect(view.canAttach).toBe(false);
    expect(view.disabledReason).toBe('readonly');
  });

  it('disables the control once a constrained quota is used up', () => {
    const view = describeAttachCard(input({ quota: { used: 3, limit: 3, constrained: true } }));
    expect(view.canAttach).toBe(false);
    expect(view.disabledReason).toBe('quota-exceeded');
  });

  it('does not disable on used >= limit when the quota is not constrained', () => {
    // Mirrors serviceQuotaState's ownerless-app case, which reports
    // constrained: false regardless of the used/limit numbers it carries.
    const view = describeAttachCard(input({ quota: { used: 5, limit: 3, constrained: false } }));
    expect(view.canAttach).toBe(true);
    expect(view.disabledReason).toBeUndefined();
  });

  it('still allows attach when a constrained quota has headroom', () => {
    const view = describeAttachCard(input({ quota: { used: 1, limit: 3, constrained: true } }));
    expect(view.canAttach).toBe(true);
  });

  // Precedence: a readonly viewer must see "your role", not "quota", when
  // both would independently disable the control.
  it('reports the readonly reason ahead of quota-exceeded when both apply', () => {
    const view = describeAttachCard(
      input({ role: 'readonly', quota: { used: 3, limit: 3, constrained: true } })
    );
    expect(view.disabledReason).toBe('readonly');
  });
});

describe('formatQuotaUsage', () => {
  it('formats used/limit as a short sentence fragment', () => {
    expect(formatQuotaUsage({ used: 2, limit: 3 })).toBe('2 of 3 used');
  });

  it('formats a fully-used quota the same way', () => {
    expect(formatQuotaUsage({ used: 3, limit: 3 })).toBe('3 of 3 used');
  });
});

describe('describeAttachRefusal', () => {
  it('shows the server message verbatim when present, regardless of reason', () => {
    expect(describeAttachRefusal('quota-exceeded', 'Database quota reached (3/3).')).toBe(
      'Database quota reached (3/3).'
    );
  });

  it('falls back to reason-specific copy when the message is empty', () => {
    expect(describeAttachRefusal('ephemeral', '')).toBe(
      'This app is ephemeral and cannot have a service attached.'
    );
  });

  it('falls back to reason-specific copy when the message is whitespace-only', () => {
    expect(describeAttachRefusal('has-own-database-url', '   ')).toBe(
      'This app already has its own database connection configured.'
    );
  });

  it('falls back to reason-specific copy when the message is undefined', () => {
    expect(describeAttachRefusal('no-app-config', undefined)).toBe(
      'This app has no saved platform configuration yet.'
    );
  });

  it('gives every known refusal reason distinct fallback copy', () => {
    const reasons = [
      'ephemeral',
      'has-own-database-url',
      'has-own-redis-url',
      'quota-exceeded',
      'no-app-config',
      'service-unavailable',
    ] as const;
    const texts = new Set(reasons.map(reason => describeAttachRefusal(reason, undefined)));
    expect(texts.size).toBe(reasons.length);
  });

  it('falls back to a generic message when neither message nor a known reason is available', () => {
    expect(describeAttachRefusal(undefined, undefined)).toBe('Could not attach this service.');
  });

  // The dashboard is a separate package from the server: a reason value added
  // to AttachServiceResult's union after this bundle was built is a real
  // input a cached tab can receive, not a hypothetical. Mirrors the escaped
  // bug in availability-label.ts, where a direct index threw and blanked the
  // whole card instead of falling back.
  it('falls back instead of throwing when the server sends a reason this build does not know', () => {
    expect(() => describeAttachRefusal('storage-not-ready' as never, undefined)).not.toThrow();
    expect(describeAttachRefusal('storage-not-ready' as never, undefined)).toBe(
      'Could not attach this service.'
    );
  });
});

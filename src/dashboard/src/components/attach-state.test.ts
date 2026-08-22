import {
  describeAttachCard,
  describeAttachRefusal,
  describeDetachConfirm,
  describeDetachOutcome,
  describeDetachRefusal,
  formatQuotaUsage,
  isControlBlocked,
  recordServiceRefusal,
  type AttachCardInput,
  type DetachServiceSuccess,
  type PendingServiceAction,
  type QuotaState,
  type ServiceRefusals,
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

  // A cleanly attached service offers Detach — canDetach mirrors `attached`.
  it('offers detach for a cleanly attached service', () => {
    const view = describeAttachCard(input({ provisioned: true }));
    expect(view.canDetach).toBe(true);
    expect(view.detachIncomplete).toBe(false);
    expect(view.detachActionLabel).toBe('Detach');
  });

  // Never offer Detach for a service that was never provisioned in the first
  // place — mirrors the "never offer Attach for a provisioned service" rule.
  it('never offers detach for an unprovisioned service', () => {
    const view = describeAttachCard(input());
    expect(view.canDetach).toBe(false);
  });

  // The third card state (DROP-151 Phase 3, plan architecture finding A9):
  // still provisioned, but the owner's last recorded intent is 'detached' —
  // a detach whose intent was persisted (the plan's persist-first design)
  // but whose deprovisioning did not finish. The old provisioned-alone
  // derivation would show a plain "Attached" badge here, hiding the only
  // repair affordance; this state must be distinguishable and offer a way
  // to retry, not offer Attach.
  it('renders a still-provisioned, detached-intent service as detach-incomplete, not attached', () => {
    const view = describeAttachCard(input({ provisioned: true, intent: 'detached' }));
    expect(view.attached).toBe(false);
    expect(view.detachIncomplete).toBe(true);
    expect(view.previouslyDetached).toBe(true);
    expect(view.canAttach).toBe(false);
    expect(view.canDetach).toBe(true);
    expect(view.detachActionLabel).toBe('Retry detach');
  });

  // A genuinely unprovisioned, previously-detached service (a detach that DID
  // finish) must still be the existing Phase 2 "Re-attach" state, not
  // detach-incomplete — detachIncomplete requires provisioned:true.
  it('does not mark a fully-detached (unprovisioned) service as detach-incomplete', () => {
    const view = describeAttachCard(input({ provisioned: false, intent: 'detached' }));
    expect(view.detachIncomplete).toBe(false);
    expect(view.canDetach).toBe(false);
    expect(view.actionLabel).toBe('Re-attach');
  });

  // Symmetric with the readonly gate on Attach: a readonly viewer must not
  // be offered Detach either, on a cleanly attached service...
  it('does not offer detach for a readonly viewer on a cleanly attached service', () => {
    const view = describeAttachCard(input({ provisioned: true, role: 'readonly' }));
    expect(view.attached).toBe(true);
    expect(view.canDetach).toBe(false);
  });

  // ...nor on a detach-incomplete one — a readonly viewer must never see a
  // "Retry detach" control it has no permission to use.
  it('does not offer retry-detach for a readonly viewer when detach is incomplete', () => {
    const view = describeAttachCard(
      input({ provisioned: true, intent: 'detached', role: 'readonly' })
    );
    expect(view.detachIncomplete).toBe(true);
    expect(view.canDetach).toBe(false);
  });

  // `broken: 'database-missing'` is a stale registry entry — the
  // database is gone but credentials (and the quota slot they occupy) are
  // still on record. The one working repair path (`DELETE .../services/:id`,
  // whose own `isProvisioned()` check is credentials-based) must stay
  // reachable even though `provisioned` reads false — a quota-exceeded owner
  // must not get BOTH named affordances (Attach and Detach) hidden at once.
  it('offers Detach for a broken database-missing record even when the owner is quota-exceeded (the bug this fixes)', () => {
    const view = describeAttachCard(
      input({
        provisioned: false,
        broken: 'database-missing',
        quota: { used: 3, limit: 3, constrained: true },
      })
    );
    expect(view.canAttach).toBe(false);
    expect(view.disabledReason).toBe('quota-exceeded');
    expect(view.canDetach).toBe(true);
    expect(view.detachActionLabel).toBe('Detach');
  });

  it('offers Detach for a broken database-missing record with quota headroom too', () => {
    const view = describeAttachCard(input({ provisioned: false, broken: 'database-missing' }));
    expect(view.canAttach).toBe(true);
    expect(view.canDetach).toBe(true);
  });

  it('does not offer Detach for a readonly viewer on a broken database-missing record', () => {
    const view = describeAttachCard(
      input({ provisioned: false, broken: 'database-missing', role: 'readonly' })
    );
    expect(view.canDetach).toBe(false);
  });

  it('still never offers Detach for an ordinary unprovisioned, non-broken service under quota exhaustion (no regression)', () => {
    const view = describeAttachCard(
      input({ provisioned: false, quota: { used: 3, limit: 3, constrained: true } })
    );
    expect(view.canDetach).toBe(false);
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

describe('recordServiceRefusal', () => {
  // The behaviour fix this function exists for: a stale attach refusal must
  // not survive a later detach refusal for the same service. Before the
  // merge to one map, DatabaseTab.tsx rendered `attachRefusals[id] ??
  // detachRefusals[id]`, and handleDetach only ever cleared its own map — so
  // an attach refusal followed by a failed detach on the same service kept
  // showing the (now stale, wrong) attach reason.
  it('replaces an earlier attach refusal with a later detach refusal on the same service', () => {
    let refusals: ServiceRefusals = {};
    refusals = recordServiceRefusal(refusals, 'postgres', {
      message: describeAttachRefusal('quota-exceeded', undefined),
    });
    refusals = recordServiceRefusal(refusals, 'postgres', {
      message: describeDetachRefusal('backup-failed', undefined),
    });

    expect(refusals.postgres?.message).toBe(
      describeDetachRefusal('backup-failed', undefined)
    );
    expect(refusals.postgres?.message).not.toBe(
      describeAttachRefusal('quota-exceeded', undefined)
    );
  });

  it('leaves a different service untouched', () => {
    let refusals: ServiceRefusals = { redis: { message: 'Redis refusal' } };
    refusals = recordServiceRefusal(refusals, 'postgres', { message: 'Postgres refusal' });

    expect(refusals.redis?.message).toBe('Redis refusal');
    expect(refusals.postgres?.message).toBe('Postgres refusal');
  });

  it('clears a service refusal when passed undefined, without touching others', () => {
    let refusals: ServiceRefusals = {
      postgres: { message: 'Postgres refusal' },
      redis: { message: 'Redis refusal' },
    };
    refusals = recordServiceRefusal(refusals, 'postgres', undefined);

    expect(refusals.postgres).toBeUndefined();
    expect(refusals.redis?.message).toBe('Redis refusal');
  });
});

describe('isControlBlocked', () => {
  const pending = (over: Partial<PendingServiceAction> = {}): PendingServiceAction => ({
    service: 'postgres',
    kind: 'attach',
    ...over,
  });

  it('never blocks any control when nothing is pending', () => {
    expect(isControlBlocked(null, 'postgres', 'attach')).toBe(false);
    expect(isControlBlocked(null, 'postgres', 'detach')).toBe(false);
    expect(isControlBlocked(null, 'redis', 'attach')).toBe(false);
    expect(isControlBlocked(null, 'redis', 'detach')).toBe(false);
  });

  it('does not block the exact control that is itself the pending action', () => {
    expect(isControlBlocked(pending({ service: 'postgres', kind: 'attach' }), 'postgres', 'attach')).toBe(
      false
    );
  });

  // A pending postgres ATTACH must block postgres's own
  // DETACH button too, not just other services' controls — the old check
  // only compared `service`, which left this exact case (and its silent
  // no-op click) live.
  it('blocks the SAME service, OTHER kind (the bug this exists to fix)', () => {
    expect(isControlBlocked(pending({ service: 'postgres', kind: 'attach' }), 'postgres', 'detach')).toBe(
      true
    );
    expect(isControlBlocked(pending({ service: 'postgres', kind: 'detach' }), 'postgres', 'attach')).toBe(
      true
    );
  });

  it('blocks a different service, same kind', () => {
    expect(isControlBlocked(pending({ service: 'postgres', kind: 'attach' }), 'redis', 'attach')).toBe(
      true
    );
  });

  it('blocks a different service, different kind', () => {
    expect(isControlBlocked(pending({ service: 'postgres', kind: 'attach' }), 'redis', 'detach')).toBe(
      true
    );
  });
});

describe('describeDetachConfirm', () => {
  it('names where the backup goes for a non-ephemeral postgres detach', () => {
    const text = describeDetachConfirm('postgres', false);
    expect(text).toMatch(/backup/i);
    expect(text).not.toMatch(/ephemeral/i);
  });

  // An ephemeral app's postgres detach passes
  // `skipBackup: true` (platform.ts) — the dialog must say plainly that no
  // backup is written, not repeat the non-ephemeral promise.
  it('says plainly that no backup is written for an ephemeral postgres detach', () => {
    const text = describeDetachConfirm('postgres', true);
    expect(text).not.toMatch(/backup is written under/i);
    expect(text.toLowerCase()).toContain('no backup');
  });

  it('keeps the existing "no backup at all" redis copy regardless of the ephemeral flag', () => {
    const nonEphemeral = describeDetachConfirm('redis', false);
    const ephemeral = describeDetachConfirm('redis', true);
    expect(nonEphemeral).toBe(ephemeral);
    expect(nonEphemeral).toContain('There is NO backup.');
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

describe('describeDetachRefusal', () => {
  it('shows the server message verbatim when present, regardless of reason', () => {
    expect(describeDetachRefusal('detach-limit', 'Detach cooldown active.')).toBe(
      'Detach cooldown active.'
    );
  });

  it('falls back to reason-specific copy when the message is empty', () => {
    expect(describeDetachRefusal('credentials-missing', '')).toBe(
      'This app has a live database DROP no longer holds credentials for — contact an administrator.'
    );
  });

  it('falls back to a generic message for an unrecognised reason instead of throwing', () => {
    expect(() => describeDetachRefusal('storage-not-ready', undefined)).not.toThrow();
    expect(describeDetachRefusal('storage-not-ready', undefined)).toBe(
      'Could not detach this service.'
    );
  });

  it('falls back to a generic message when neither message nor reason is available', () => {
    expect(describeDetachRefusal(undefined, undefined)).toBe('Could not detach this service.');
  });

  // The one useful fact a rate-limited caller needs is when to retry.
  it('appends a retry-after suffix for a detach-limit refusal with retryAfterSeconds', () => {
    expect(describeDetachRefusal('detach-limit', undefined, 120)).toBe(
      'Too many detach attempts for this app right now. Try again in 120s.'
    );
  });

  it('does not append a retry-after suffix for a non-detach-limit reason', () => {
    expect(describeDetachRefusal('service-unavailable', undefined, 120)).toBe(
      'This service is not available on this platform.'
    );
  });

  it('does not append a retry-after suffix when retryAfterSeconds is absent or zero', () => {
    expect(describeDetachRefusal('detach-limit', undefined)).toBe(
      'Too many detach attempts for this app right now.'
    );
    expect(describeDetachRefusal('detach-limit', undefined, 0)).toBe(
      'Too many detach attempts for this app right now.'
    );
  });

  // 'backup-failed' is a real refusal reason the DELETE route returns
  // (apps.ts) but the fallback table used to be missing it entirely — now
  // that DetachRefusalReason is a closed union, every reason gets copy.
  it('has fallback copy for backup-failed', () => {
    expect(describeDetachRefusal('backup-failed', undefined)).toMatch(/backup/i);
  });

  // A failed Redis FLUSHDB is no longer a refusal reason at all — the
  // server returns it as a SUCCESS (`flushed: false`), so 'flush-failed' is
  // an unrecognised string here and must fall through to the generic
  // message like any other reason this build doesn't know, not get its own
  // (now-removed) fallback entry.
  it('falls back to the generic message for the now-removed flush-failed reason', () => {
    expect(describeDetachRefusal('flush-failed', undefined)).toBe('Could not detach this service.');
  });
});

describe('describeDetachOutcome', () => {
  const base: DetachServiceSuccess = { detached: true, deprovisioned: true, restart: 'restarted' };

  it('reports a clean detach with no backup file', () => {
    expect(describeDetachOutcome('Redis', { ...base, flushed: true })).toBe(
      'Redis detached from the app.'
    );
  });

  it('reports the backup file when present', () => {
    expect(
      describeDetachOutcome('PostgreSQL', {
        ...base,
        databaseDropped: true,
        roleDropped: true,
        backup: { written: true, file: 'myapp-postgres-20260820.dump.gz' },
      })
    ).toBe('PostgreSQL detached. Backup written: myapp-postgres-20260820.dump.gz.');
  });

  it('reports nothing-to-remove when the service was never actually provisioned', () => {
    expect(describeDetachOutcome('Redis', { ...base, deprovisioned: false })).toBe(
      'Redis detach recorded — nothing was provisioned to remove.'
    );
  });

  // `flushed: false` is a SUCCESS outcome (the allocation was freed
  // and the number tombstoned regardless of whether FLUSHDB itself
  // succeeded) — this must read as "detached, but..." not as a refusal, and
  // must name the real residue (data isolated, flushed before reuse) rather
  // than repeat the old refusal's now-false "nothing was removed" claim.
  it('reports an honest partial line when a redis flush could not complete, without claiming nothing was removed', () => {
    const text = describeDetachOutcome('Redis', { ...base, flushed: false });
    expect(text).toContain('Redis detached from the app.');
    expect(text).not.toMatch(/nothing was removed/i);
    expect(text.toLowerCase()).toContain('flushed before');
  });

  it('appends an honest partial line when role cleanup did not finish', () => {
    expect(
      describeDetachOutcome('PostgreSQL', { ...base, databaseDropped: true, roleDropped: false })
    ).toBe('PostgreSQL detached from the app. Role cleanup incomplete — retained for retry.');
  });

  it('appends an honest partial line when the app needs configuration to restart', () => {
    expect(describeDetachOutcome('PostgreSQL', { ...base, restart: 'needs-config' })).toBe(
      'PostgreSQL detached from the app. The app needs configuration before it can restart.'
    );
  });

  it('appends an honest partial line when the restart failed', () => {
    expect(describeDetachOutcome('PostgreSQL', { ...base, restart: 'failed' })).toBe(
      'PostgreSQL detached from the app. The app failed to restart — check its status.'
    );
  });

  it('appends a neutral line when the app was not running to begin with', () => {
    expect(describeDetachOutcome('PostgreSQL', { ...base, restart: 'not-restarted' })).toBe(
      'PostgreSQL detached from the app. The app was not running, so it was not restarted.'
    );
  });

  it('combines multiple partial flags into one honest sentence', () => {
    expect(
      describeDetachOutcome('PostgreSQL', {
        ...base,
        databaseDropped: true,
        roleDropped: false,
        restart: 'needs-config',
      })
    ).toBe(
      'PostgreSQL detached from the app. Role cleanup incomplete — retained for retry. ' +
        'The app needs configuration before it can restart.'
    );
  });

  // `backup.file` is optional on the wire (absent for a
  // skipped-backup ephemeral detach, or when nothing was found to dump) — a
  // `written: true` backup with no file must never render "Backup written:
  // undefined.".
  it('does not render a bogus "Backup written: undefined." when backup.written is true but file is absent', () => {
    const text = describeDetachOutcome('PostgreSQL', { ...base, backup: { written: true } });
    expect(text).toBe('PostgreSQL detached from the app.');
    expect(text).not.toMatch(/undefined/);
  });

  // manifestConflict was computed by the platform on
  // every detach but rendered nowhere until now.
  it('reports when drop.yaml still declares the detached service', () => {
    const text = describeDetachOutcome('PostgreSQL', { ...base, manifestConflict: true });
    expect(text).toContain('PostgreSQL detached from the app.');
    expect(text).toMatch(/drop\.yaml still declares PostgreSQL/);
    expect(text).toMatch(/re-attaching would hand authority back/i);
  });

  it('says nothing extra about the manifest when there is no conflict', () => {
    const text = describeDetachOutcome('PostgreSQL', { ...base, manifestConflict: false });
    expect(text).not.toMatch(/drop\.yaml/);
  });

  it('composes the manifest-conflict line alongside another partial flag', () => {
    const text = describeDetachOutcome('PostgreSQL', {
      ...base,
      restart: 'not-restarted',
      manifestConflict: true,
    });
    expect(text).toBe(
      'PostgreSQL detached from the app. The app was not running, so it was not restarted. ' +
        "This app's drop.yaml still declares PostgreSQL — that declaration is ignored for now; " +
        're-attaching would hand authority back to it.'
    );
  });
});

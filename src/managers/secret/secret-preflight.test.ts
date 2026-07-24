/**
 * Unit tests for the pure secret-preflight logic (PRD-051).
 */

import {
  normalizeSecretDecl,
  normalizeSecrets,
  generateSecretValue,
  planSecretPreflight,
} from './secret-preflight';
import type { AppSecretsConfig } from '@core/detector/drop-yaml-parser';

describe('normalizeSecretDecl', () => {
  it('expands boolean and string shorthands', () => {
    expect(normalizeSecretDecl('A', true)).toEqual({ name: 'A', required: true });
    expect(normalizeSecretDecl('A', false)).toEqual({ name: 'A', required: false });
    expect(normalizeSecretDecl('A', 'required')).toEqual({ name: 'A', required: true });
    expect(normalizeSecretDecl('A', 'generate')).toEqual({ name: 'A', required: true, generate: 'random' });
  });

  it('object form: generate implies required even when required is omitted', () => {
    expect(normalizeSecretDecl('JWT', { generate: 'random' })).toEqual({
      name: 'JWT',
      required: true,
      generate: 'random',
    });
  });

  it('object form: required + description carried through', () => {
    expect(normalizeSecretDecl('SMTP', { required: true, description: 'relay pw' })).toEqual({
      name: 'SMTP',
      required: true,
      description: 'relay pw',
    });
  });

  it('object form: required:false with no generate stays optional', () => {
    expect(normalizeSecretDecl('OPT', { required: false })).toEqual({ name: 'OPT', required: false });
  });
});

describe('normalizeSecrets', () => {
  it('returns [] for undefined and preserves declaration order', () => {
    expect(normalizeSecrets(undefined)).toEqual([]);
    const decl: AppSecretsConfig = { B: 'required', A: 'generate' };
    expect(normalizeSecrets(decl).map(d => d.name)).toEqual(['B', 'A']);
  });
});

describe('generateSecretValue', () => {
  it('returns a URL-safe base64 string with no padding', () => {
    const v = generateSecretValue('random');
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v).not.toContain('=');
    // 32 bytes -> 43 base64url chars.
    expect(v.length).toBe(43);
  });

  it('is unique across calls (CSPRNG)', () => {
    const values = new Set(Array.from({ length: 100 }, () => generateSecretValue()));
    expect(values.size).toBe(100);
  });
});

describe('planSecretPreflight', () => {
  it('no declaration -> satisfied, nothing to do', () => {
    expect(planSecretPreflight(undefined, [])).toEqual({ toGenerate: [], missing: [], satisfied: true });
  });

  it('required + already provided -> satisfied, no generate/missing', () => {
    const plan = planSecretPreflight({ JWT_SECRET: 'required' }, ['JWT_SECRET']);
    expect(plan.satisfied).toBe(true);
    expect(plan.toGenerate).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it('required + generate + not provided -> queued for generation, still satisfied', () => {
    const plan = planSecretPreflight({ JWT_SECRET: 'generate' }, []);
    expect(plan.satisfied).toBe(true);
    expect(plan.toGenerate.map(d => d.name)).toEqual(['JWT_SECRET']);
    expect(plan.missing).toEqual([]);
  });

  it('generatable but already set -> neither generate nor missing', () => {
    const plan = planSecretPreflight({ JWT_SECRET: { generate: 'random' } }, ['JWT_SECRET']);
    expect(plan.toGenerate).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.satisfied).toBe(true);
  });

  it('required human-supplied + not provided -> missing, NOT satisfied', () => {
    const plan = planSecretPreflight({ SMTP_PASSWORD: { required: true, description: 'pw' } }, []);
    expect(plan.satisfied).toBe(false);
    expect(plan.missing.map(d => d.name)).toEqual(['SMTP_PASSWORD']);
    expect(plan.missing[0].description).toBe('pw');
    expect(plan.toGenerate).toEqual([]);
  });

  it('non-required declaration is advisory and never blocks', () => {
    const plan = planSecretPreflight({ SENTRY_DSN: { required: false } }, []);
    expect(plan.satisfied).toBe(true);
    expect(plan.missing).toEqual([]);
    expect(plan.toGenerate).toEqual([]);
  });

  it('mixed declaration resolves each independently', () => {
    const decl: AppSecretsConfig = {
      JWT_SECRET: 'generate', // -> generate
      SMTP_PASSWORD: 'required', // -> missing
      API_KEY: 'required', // provided -> satisfied
      DEBUG_FLAG: false, // optional -> ignored
    };
    const plan = planSecretPreflight(decl, ['API_KEY']);
    expect(plan.toGenerate.map(d => d.name)).toEqual(['JWT_SECRET']);
    expect(plan.missing.map(d => d.name)).toEqual(['SMTP_PASSWORD']);
    expect(plan.satisfied).toBe(false);
  });

  it('accepts providedKeys as a Set or an array equivalently', () => {
    const decl: AppSecretsConfig = { JWT_SECRET: 'required' };
    expect(planSecretPreflight(decl, new Set(['JWT_SECRET'])).satisfied).toBe(true);
    expect(planSecretPreflight(decl, ['JWT_SECRET']).satisfied).toBe(true);
  });
});

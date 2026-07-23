/**
 * Unit tests for computeAppUrl — the dashboard's external-URL derivation.
 *
 * The served host is computed from the platform's domain suffix at read time,
 * NOT read from the persisted `<name>.localhost` placeholder (P0-6 hijack guard;
 * see AppConfigService.getDomainOwners). These tests pin that behaviour and the
 * customDomain / drop.yaml-domains / tls-disabled precedence.
 */
import { setApiRuntimeConfig } from '../runtime-config';

// computeAppUrl consults the app-config singleton for drop.yaml domains / tls.
// Mock it so tests control that input without touching the filesystem. Default
// throws, exercising the "config service not initialised" fall-through to the
// default host.
jest.mock('../../managers/app/app-config', () => ({
  getAppConfigService: jest.fn(() => {
    throw new Error('config service not initialised');
  }),
}));

import { getAppConfigService } from '../../managers/app/app-config';
import { computeAppUrl } from './apps';
import type { AppState } from '../../managers/app/state-manager';

const mockConfigService = getAppConfigService as jest.Mock;

function makeApp(over: Partial<AppState> = {}): AppState {
  return { name: 'waitlist', ...over } as AppState;
}

function withConfig(cfg: { domains?: string[]; tls?: { disabled?: boolean }; publicUrl?: string }): void {
  mockConfigService.mockReturnValue({ getConfig: () => cfg });
}

describe('computeAppUrl', () => {
  beforeEach(() => {
    // Default: no config service (isolated route) — computeAppUrl uses the default host.
    mockConfigService.mockImplementation(() => {
      throw new Error('config service not initialised');
    });
    setApiRuntimeConfig({ domainSuffix: 'dropkit.sh', enableHttps: true });
  });

  it('builds https://<name>.<domainSuffix> on an HTTPS real-domain box', () => {
    expect(computeAppUrl(makeApp())).toBe('https://waitlist.dropkit.sh');
  });

  it('uses http when HTTPS is disabled', () => {
    setApiRuntimeConfig({ enableHttps: false });
    expect(computeAppUrl(makeApp())).toBe('http://waitlist.dropkit.sh');
  });

  it('returns undefined for a localhost suffix (dashboard falls back to host:port)', () => {
    setApiRuntimeConfig({ domainSuffix: 'localhost' });
    expect(computeAppUrl(makeApp())).toBeUndefined();
  });

  it('prefers a dashboard-set customDomain over the default host', () => {
    expect(computeAppUrl(makeApp({ customDomain: 'shop.example.org' }))).toBe('https://shop.example.org');
  });

  it('treats a .localhost customDomain as non-external (undefined)', () => {
    expect(computeAppUrl(makeApp({ customDomain: 'foo.localhost' }))).toBeUndefined();
  });

  it('ignores an empty-string customDomain and falls through to the default host', () => {
    expect(computeAppUrl(makeApp({ customDomain: '' }))).toBe('https://waitlist.dropkit.sh');
  });

  it('uses the app config drop.yaml domain when set and there is no customDomain', () => {
    withConfig({ domains: ['declared.example.com'] });
    expect(computeAppUrl(makeApp())).toBe('https://declared.example.com');
  });

  it('serves http when the app disables TLS in drop.yaml, even on an HTTPS box', () => {
    withConfig({ domains: ['declared.example.com'], tls: { disabled: true } });
    expect(computeAppUrl(makeApp())).toBe('http://declared.example.com');
  });

  // Same-origin monorepo children: the child serves on the GROUP domain, never
  // its own `<name>` subdomain, so the name-based default is a dead link (the
  // reported bug — the dashboard showed ezsign-frontend.dropkit.sh, which has no
  // route/cert). handleConfigureRoute persists the real URL as publicUrl.
  it('returns the persisted group publicUrl for a same-origin frontend child', () => {
    withConfig({ publicUrl: 'https://ezsign.dropkit.sh' });
    expect(computeAppUrl(makeApp({ name: 'ezsign-frontend' }))).toBe('https://ezsign.dropkit.sh');
  });

  it('returns the group publicUrl WITH its route path for a backend child', () => {
    withConfig({ publicUrl: 'https://ezsign.dropkit.sh/api' });
    expect(computeAppUrl(makeApp({ name: 'ezsign-backend' }))).toBe('https://ezsign.dropkit.sh/api');
  });

  it('lets a dashboard-set customDomain override a persisted publicUrl', () => {
    withConfig({ publicUrl: 'https://ezsign.dropkit.sh' });
    expect(computeAppUrl(makeApp({ name: 'ezsign-frontend', customDomain: 'app.example.org' }))).toBe(
      'https://app.example.org'
    );
  });

  it('lets an explicit drop.yaml domain override a persisted publicUrl', () => {
    withConfig({ domains: ['declared.example.com'], publicUrl: 'https://ezsign.dropkit.sh' });
    expect(computeAppUrl(makeApp({ name: 'ezsign-frontend' }))).toBe('https://declared.example.com');
  });

  it('is unaffected for a standalone app (no publicUrl) — still the name-based default', () => {
    withConfig({});
    expect(computeAppUrl(makeApp())).toBe('https://waitlist.dropkit.sh');
  });
});

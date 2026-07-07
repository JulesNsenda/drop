/**
 * Certificates Routes
 *
 * API endpoints for TLS certificate information and management.
 */

import { Hono } from 'hono';
import { success, error, ErrorCodes } from '../types';
import { NotFoundError } from '../middleware/error';
import { getCaddyAdminClient, CertificateInfo } from '../../managers/router/caddy-api';
import { AuthContext } from '../middleware/auth';
import { canAccess } from '../access';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppConfigService } from '../../managers/app/app-config';

const certs = new Hono();

/**
 * The lowercased set of domains the caller is allowed to see certificates for,
 * or `null` meaning "all" (admin, or auth disabled). Without this, any
 * authenticated user — even readonly — could enumerate every tenant's custom
 * domains, issuers and expiry dates from the shared Caddy instance.
 */
function ownedDomains(auth: AuthContext | undefined): Set<string> | null {
  if (!auth || auth.role === 'admin') return null;

  const domains = new Set<string>();
  const stateManager = getStateManager();

  let configService: ReturnType<typeof getAppConfigService> | null = null;
  try {
    configService = getAppConfigService();
  } catch {
    configService = null; // config service not initialized — fall back to state only
  }

  for (const app of stateManager.getAllApps()) {
    if (!canAccess(auth, app)) continue;
    if (app.hostname) domains.add(app.hostname.toLowerCase());
    if (app.customDomain) domains.add(app.customDomain.toLowerCase());
    // Multi-domain apps keep their full domain list in the app config file.
    const cfg = configService?.getConfig(app.name);
    for (const d of cfg?.domains ?? []) domains.add(d.toLowerCase());
  }
  return domains;
}

/** Whether a certificate is visible to the caller given their owned-domain set. */
function certVisible(cert: CertificateInfo, owned: Set<string> | null): boolean {
  return owned === null || owned.has(cert.domain.toLowerCase());
}

/**
 * Certificate DTO for API responses
 */
interface CertificateDto {
  domain: string;
  issuer: string;
  notBefore: string | null;
  notAfter: string | null;
  daysUntilExpiry: number;
  status: 'valid' | 'expiring' | 'expired' | 'pending' | 'error';
  sans: string[];
  managed: boolean;
  error?: string;
}

/**
 * Convert CertificateInfo to DTO
 */
function toCertDto(cert: CertificateInfo): CertificateDto {
  return {
    domain: cert.domain,
    issuer: cert.issuer,
    notBefore: cert.notBefore || null,
    notAfter: cert.notAfter || null,
    daysUntilExpiry: cert.daysUntilExpiry,
    status: cert.status,
    sans: cert.sans || [],
    managed: cert.managed,
    error: cert.error,
  };
}

// GET /certs - List all certificates
certs.get('/', async (c) => {
  const client = getCaddyAdminClient();

  // Check if Caddy admin API is available
  const available = await client.isAvailable();
  if (!available) {
    return c.json(
      error(
        ErrorCodes.SERVICE_UNAVAILABLE,
        'Caddy admin API is not available'
      ),
      503
    );
  }

  const auth = (c.get as (k: string) => AuthContext | undefined)('auth');
  const owned = ownedDomains(auth);
  const certificates = (await client.getCertificates()).filter((cert) =>
    certVisible(cert, owned)
  );

  // Filter by status if query param provided
  const statusFilter = c.req.query('status');
  let filtered = certificates;

  if (statusFilter) {
    filtered = certificates.filter(cert => cert.status === statusFilter);
  }

  // Check for expiring certificates and add warning
  const expiring = certificates.filter(cert =>
    cert.status === 'expiring' || cert.status === 'expired'
  );

  return c.json(
    success(
      filtered.map(toCertDto),
      {
        total: filtered.length,
        expiring: expiring.length,
        warning: expiring.length > 0
          ? `${expiring.length} certificate(s) expiring or expired`
          : undefined,
      }
    )
  );
});

// GET /certs/expiring - Get certificates expiring within N days
certs.get('/expiring', async (c) => {
  const client = getCaddyAdminClient();

  // Check if Caddy admin API is available
  const available = await client.isAvailable();
  if (!available) {
    return c.json(
      error(
        ErrorCodes.SERVICE_UNAVAILABLE,
        'Caddy admin API is not available'
      ),
      503
    );
  }

  // Get days threshold from query param (default 7)
  const daysParam = c.req.query('days');
  const days = daysParam ? parseInt(daysParam, 10) : 7;

  if (isNaN(days) || days < 0) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        'Invalid days parameter'
      ),
      400
    );
  }

  const auth = (c.get as (k: string) => AuthContext | undefined)('auth');
  const owned = ownedDomains(auth);
  const certificates = (await client.getExpiringCertificates(days)).filter((cert) =>
    certVisible(cert, owned)
  );

  return c.json(
    success(
      certificates.map(toCertDto),
      {
        total: certificates.length,
        daysThreshold: days,
      }
    )
  );
});

// GET /certs/:domain - Get certificate for a specific domain
certs.get('/:domain', async (c) => {
  const domain = c.req.param('domain');
  const client = getCaddyAdminClient();

  // Check if Caddy admin API is available
  const available = await client.isAvailable();
  if (!available) {
    return c.json(
      error(
        ErrorCodes.SERVICE_UNAVAILABLE,
        'Caddy admin API is not available'
      ),
      503
    );
  }

  const auth = (c.get as (k: string) => AuthContext | undefined)('auth');
  const owned = ownedDomains(auth);
  const certificate = await client.getCertificateForDomain(domain);

  // Return 404 (not 403) for both missing and unauthorized so we don't confirm
  // the existence of another tenant's certificate.
  if (!certificate || !certVisible(certificate, owned)) {
    throw new NotFoundError(`No certificate found for domain '${domain}'`);
  }

  return c.json(success(toCertDto(certificate)));
});

// POST /certs/renew - Trigger certificate renewal
certs.post('/renew', async (c) => {
  const client = getCaddyAdminClient();

  // Check if Caddy admin API is available
  const available = await client.isAvailable();
  if (!available) {
    return c.json(
      error(
        ErrorCodes.SERVICE_UNAVAILABLE,
        'Caddy admin API is not available'
      ),
      503
    );
  }

  const renewed = await client.triggerRenewal();

  if (!renewed) {
    return c.json(
      error(
        ErrorCodes.INTERNAL_ERROR,
        'Failed to trigger certificate renewal'
      ),
      500
    );
  }

  return c.json(
    success({
      message: 'Certificate renewal triggered',
      note: 'Certificates will be renewed if they are within the renewal window',
    })
  );
});

// GET /certs/health - Get certificate health summary
certs.get('/health', async (c) => {
  const client = getCaddyAdminClient();

  // Check if Caddy admin API is available
  const available = await client.isAvailable();
  if (!available) {
    return c.json(
      error(
        ErrorCodes.SERVICE_UNAVAILABLE,
        'Caddy admin API is not available'
      ),
      503
    );
  }

  const auth = (c.get as (k: string) => AuthContext | undefined)('auth');
  const owned = ownedDomains(auth);
  const certificates = (await client.getCertificates()).filter((cert) =>
    certVisible(cert, owned)
  );

  const summary = {
    total: certificates.length,
    valid: certificates.filter(c => c.status === 'valid').length,
    expiring: certificates.filter(c => c.status === 'expiring').length,
    expired: certificates.filter(c => c.status === 'expired').length,
    pending: certificates.filter(c => c.status === 'pending').length,
    error: certificates.filter(c => c.status === 'error').length,
  };

  const healthy = summary.expired === 0 && summary.error === 0;

  return c.json(
    success({
      healthy,
      summary,
      message: healthy
        ? 'All certificates are healthy'
        : `${summary.expired + summary.error} certificate(s) need attention`,
    })
  );
});

export default certs;

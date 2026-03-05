/**
 * Certificates Routes
 *
 * API endpoints for TLS certificate information and management.
 */

import { Hono } from 'hono';
import { success, error, ErrorCodes } from '../types';
import { NotFoundError } from '../middleware/error';
import { getCaddyAdminClient, CertificateInfo } from '../../managers/router/caddy-api';

const certs = new Hono();

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

  const certificates = await client.getCertificates();

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

  const certificates = await client.getExpiringCertificates(days);

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

  const certificate = await client.getCertificateForDomain(domain);

  if (!certificate) {
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

  const certificates = await client.getCertificates();

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

/**
 * Caddy Admin API Client
 *
 * Interacts with Caddy's admin API for certificate management and monitoring.
 */

/**
 * Certificate information from Caddy
 */
export interface CertificateInfo {
  /** Domain the certificate is for */
  domain: string;
  /** Certificate issuer (e.g., "Let's Encrypt", "ZeroSSL") */
  issuer: string;
  /** Certificate valid from date (ISO string) */
  notBefore: string;
  /** Certificate valid until date (ISO string) */
  notAfter: string;
  /** Days until certificate expires */
  daysUntilExpiry: number;
  /** Certificate status */
  status: 'valid' | 'expiring' | 'expired' | 'pending' | 'error';
  /** Subject Alternative Names */
  sans?: string[];
  /** Whether this is a managed (auto-renewed) certificate */
  managed: boolean;
  /** Error message if status is 'error' */
  error?: string;
}

/**
 * Caddy config API response structure
 */
interface CaddyConfigResponse {
  apps?: {
    tls?: {
      certificates?: {
        automate?: string[];
        load_files?: Array<{
          certificate: string;
          key: string;
          tags?: string[];
        }>;
      };
      automation?: {
        policies?: Array<{
          subjects?: string[];
          issuers?: Array<{
            module: string;
            ca?: string;
            email?: string;
          }>;
        }>;
      };
    };
  };
}

/**
 * PKIX info from Caddy's PKI app
 */
interface CaddyPkiCertInfo {
  subject: {
    common_name?: string;
  };
  issuer: {
    common_name?: string;
    organization?: string[];
  };
  serial_number: string;
  not_before: string;
  not_after: string;
  subject_alternative_names?: {
    dns_names?: string[];
  };
}

/**
 * Client for Caddy's Admin API
 */
export class CaddyAdminClient {
  private readonly adminUrl: string;
  private readonly timeout: number;

  constructor(adminUrl: string = 'http://localhost:2019', timeout: number = 5000) {
    this.adminUrl = adminUrl.replace(/\/$/, ''); // Remove trailing slash
    this.timeout = timeout;
  }

  /**
   * Check if the Caddy admin API is reachable
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.adminUrl}/config/`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeout),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get the current Caddy configuration
   */
  async getConfig(): Promise<CaddyConfigResponse | null> {
    try {
      const response = await fetch(`${this.adminUrl}/config/`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        return null;
      }

      return await response.json() as CaddyConfigResponse;
    } catch {
      return null;
    }
  }

  /**
   * Get all managed certificates
   *
   * Note: Caddy doesn't expose certificate details directly via admin API,
   * so we infer from the TLS configuration which domains have certificates.
   */
  async getCertificates(): Promise<CertificateInfo[]> {
    const certificates: CertificateInfo[] = [];

    try {
      // Get PKI certificates if available
      const pkiCerts = await this.getPkiCertificates();
      certificates.push(...pkiCerts);

      // If no PKI info, try to get info from config
      if (certificates.length === 0) {
        const configCerts = await this.getCertificatesFromConfig();
        certificates.push(...configCerts);
      }
    } catch {
      // API not available or error
    }

    return certificates;
  }

  /**
   * Try to get certificate info from Caddy's PKI app
   */
  private async getPkiCertificates(): Promise<CertificateInfo[]> {
    const certificates: CertificateInfo[] = [];

    try {
      // Caddy's PKI app endpoint (may not be available in all versions)
      const response = await fetch(`${this.adminUrl}/pki/ca/local/certificates`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        return [];
      }

      const certs = await response.json() as Record<string, CaddyPkiCertInfo>;

      for (const [_id, cert] of Object.entries(certs)) {
        const notAfter = new Date(cert.not_after);
        const now = new Date();
        const daysUntilExpiry = Math.floor((notAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        const domains = cert.subject_alternative_names?.dns_names || [];
        const domain = domains[0] || cert.subject.common_name || 'unknown';

        certificates.push({
          domain,
          issuer: cert.issuer.organization?.[0] || cert.issuer.common_name || 'Unknown',
          notBefore: cert.not_before,
          notAfter: cert.not_after,
          daysUntilExpiry,
          status: this.getCertStatus(daysUntilExpiry),
          sans: domains,
          managed: true,
        });
      }
    } catch {
      // PKI endpoint not available
    }

    return certificates;
  }

  /**
   * Get certificate domains from Caddy config
   * This provides a list of domains that should have certificates, even if
   * we can't get the actual certificate details.
   */
  private async getCertificatesFromConfig(): Promise<CertificateInfo[]> {
    const certificates: CertificateInfo[] = [];

    try {
      const config = await this.getConfig();
      if (!config?.apps?.tls) {
        return [];
      }

      const tls = config.apps.tls;

      // Get automated certificate domains
      if (tls.certificates?.automate) {
        for (const domain of tls.certificates.automate) {
          certificates.push({
            domain,
            issuer: 'Pending',
            notBefore: '',
            notAfter: '',
            daysUntilExpiry: 0,
            status: 'pending',
            managed: true,
          });
        }
      }

      // Get manually loaded certificates
      if (tls.certificates?.load_files) {
        for (const file of tls.certificates.load_files) {
          const domain = file.tags?.[0] || 'manual';
          certificates.push({
            domain,
            issuer: 'Manual',
            notBefore: '',
            notAfter: '',
            daysUntilExpiry: 0,
            status: 'valid', // Assume valid for manual certs
            managed: false,
          });
        }
      }
    } catch {
      // Config not available
    }

    return certificates;
  }

  /**
   * Get certificate info for a specific domain
   */
  async getCertificateForDomain(domain: string): Promise<CertificateInfo | null> {
    const certificates = await this.getCertificates();

    // Exact match first
    let cert = certificates.find(c => c.domain === domain);
    if (cert) {
      return cert;
    }

    // Check SANs
    cert = certificates.find(c => c.sans?.includes(domain));
    if (cert) {
      return cert;
    }

    // Check wildcard match
    const domainParts = domain.split('.');
    if (domainParts.length > 1) {
      const wildcardDomain = `*.${domainParts.slice(1).join('.')}`;
      cert = certificates.find(c =>
        c.domain === wildcardDomain ||
        c.sans?.includes(wildcardDomain)
      );
      if (cert) {
        return cert;
      }
    }

    return null;
  }

  /**
   * Get certificates that are expiring soon
   */
  async getExpiringCertificates(daysThreshold: number = 7): Promise<CertificateInfo[]> {
    const certificates = await this.getCertificates();
    return certificates.filter(c =>
      c.daysUntilExpiry <= daysThreshold &&
      c.status !== 'pending' &&
      c.status !== 'error'
    );
  }

  /**
   * Force certificate renewal for a domain
   * Note: This triggers a config reload which will renew expiring certs
   */
  async triggerRenewal(): Promise<boolean> {
    try {
      // Reload the config to trigger certificate checks
      const response = await fetch(`${this.adminUrl}/load`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: '{}', // Empty config to just trigger a refresh
        signal: AbortSignal.timeout(this.timeout),
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Determine certificate status based on days until expiry
   */
  private getCertStatus(daysUntilExpiry: number): CertificateInfo['status'] {
    if (daysUntilExpiry < 0) {
      return 'expired';
    }
    if (daysUntilExpiry <= 7) {
      return 'expiring';
    }
    return 'valid';
  }
}

// Singleton instance
let adminClientInstance: CaddyAdminClient | null = null;

export function getCaddyAdminClient(adminUrl?: string): CaddyAdminClient {
  if (!adminClientInstance) {
    adminClientInstance = new CaddyAdminClient(adminUrl);
  }
  return adminClientInstance;
}

export function resetCaddyAdminClient(): void {
  adminClientInstance = null;
}

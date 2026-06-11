/**
 * Domain Validator
 *
 * Utilities for validating domain names and checking DNS resolution.
 */

import * as dns from 'dns/promises';
import * as os from 'os';

/**
 * Result of domain validation
 */
export interface DomainValidationResult {
  /** Whether the domain format is valid */
  valid: boolean;
  /** Whether the domain resolves via DNS */
  resolves: boolean;
  /** Whether the domain points to this server's IP */
  pointsToThisServer: boolean;
  /** Warning messages (non-blocking issues) */
  warnings: string[];
  /** Error messages (blocking issues) */
  errors: string[];
}

/**
 * Result of DNS resolution check
 */
export interface DnsResolutionResult {
  /** Whether the domain resolved successfully */
  resolves: boolean;
  /** Resolved IP addresses */
  addresses: string[];
  /** Error message if resolution failed */
  error?: string;
}

/**
 * Validate a domain name format
 *
 * Checks for:
 * - Valid characters (a-z, 0-9, hyphens)
 * - Proper label lengths (1-63 characters each)
 * - Total length (max 253 characters)
 * - No consecutive dots
 * - No leading/trailing hyphens in labels
 */
export function validateDomainFormat(domain: string): boolean {
  if (!domain || typeof domain !== 'string') {
    return false;
  }

  // Total length check
  if (domain.length > 253) {
    return false;
  }

  // Split into labels
  const labels = domain.toLowerCase().split('.');

  // Must have at least one label
  if (labels.length < 1) {
    return false;
  }

  // Validate each label
  for (const label of labels) {
    // Empty labels mean consecutive dots
    if (label.length === 0) {
      return false;
    }

    // Label length check (1-63 characters)
    if (label.length > 63) {
      return false;
    }

    // Check for valid characters and no leading/trailing hyphens
    // Punycode (xn--) labels allowed for internationalized domains
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^[a-z0-9]$/.test(label)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a domain looks like a localhost domain
 */
export function isLocalhostDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === '127.0.0.1' ||
    lower.startsWith('127.0.0.1:')
  );
}

/**
 * Check DNS resolution for a domain
 */
export async function checkDnsResolution(domain: string): Promise<DnsResolutionResult> {
  try {
    // Try to resolve both A and AAAA records
    const addresses: string[] = [];

    try {
      const ipv4 = await dns.resolve4(domain);
      addresses.push(...ipv4);
    } catch {
      // IPv4 resolution failed - not an error if IPv6 works
    }

    try {
      const ipv6 = await dns.resolve6(domain);
      addresses.push(...ipv6);
    } catch {
      // IPv6 resolution failed - not an error if IPv4 works
    }

    if (addresses.length === 0) {
      // Try a general lookup as fallback
      try {
        const result = await dns.lookup(domain, { all: true });
        addresses.push(...result.map(r => r.address));
      } catch {
        // All resolution attempts failed
      }
    }

    return {
      resolves: addresses.length > 0,
      addresses,
      error: addresses.length === 0 ? 'No DNS records found' : undefined,
    };
  } catch (error) {
    return {
      resolves: false,
      addresses: [],
      error: error instanceof Error ? error.message : 'DNS resolution failed',
    };
  }
}

/**
 * Get the local server's IP addresses
 */
export function getLocalAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;

    for (const config of iface) {
      // Skip internal/loopback addresses
      if (!config.internal) {
        addresses.push(config.address);
      }
    }
  }

  // Also include loopback for completeness
  addresses.push('127.0.0.1', '::1');

  return addresses;
}

/**
 * Check if any of the resolved addresses match a local address
 */
export function addressMatchesLocal(resolvedAddresses: string[], localAddresses: string[]): boolean {
  const localSet = new Set(localAddresses.map(a => a.toLowerCase()));

  for (const addr of resolvedAddresses) {
    if (localSet.has(addr.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Validate a domain for HTTPS use
 *
 * Performs comprehensive validation including:
 * - Format validation
 * - DNS resolution check
 * - Server IP matching
 */
export async function validateDomain(domain: string): Promise<DomainValidationResult> {
  const result: DomainValidationResult = {
    valid: false,
    resolves: false,
    pointsToThisServer: false,
    warnings: [],
    errors: [],
  };

  // Skip validation for localhost domains
  if (isLocalhostDomain(domain)) {
    result.valid = true;
    result.resolves = true;
    result.pointsToThisServer = true;
    result.warnings.push('Localhost domain - HTTPS will be disabled');
    return result;
  }

  // Validate format
  if (!validateDomainFormat(domain)) {
    result.errors.push(`Invalid domain format: ${domain}`);
    return result;
  }

  result.valid = true;

  // Check DNS resolution
  const dnsResult = await checkDnsResolution(domain);
  result.resolves = dnsResult.resolves;

  if (!dnsResult.resolves) {
    result.warnings.push(
      `Domain '${domain}' does not resolve via DNS. ` +
      'Let\'s Encrypt certificate issuance will fail until DNS is configured.'
    );
    return result;
  }

  // Check if the domain points to this server
  const localAddresses = getLocalAddresses();
  result.pointsToThisServer = addressMatchesLocal(dnsResult.addresses, localAddresses);

  if (!result.pointsToThisServer) {
    result.warnings.push(
      `Domain '${domain}' resolves to ${dnsResult.addresses.join(', ')} ` +
      'which does not match this server\'s IP addresses. ' +
      'HTTP-01 challenge may fail.'
    );
  }

  return result;
}

/**
 * Validate a wildcard domain
 *
 * Wildcards must be in the form *.example.com
 */
export function validateWildcardDomain(domain: string): { valid: boolean; error?: string } {
  // Wildcard must start with *.
  if (!domain.startsWith('*.')) {
    return {
      valid: false,
      error: 'Wildcard domain must start with *.',
    };
  }

  // Validate the rest of the domain
  const baseDomain = domain.slice(2); // Remove *.
  if (!validateDomainFormat(baseDomain)) {
    return {
      valid: false,
      error: `Invalid domain format in wildcard: ${baseDomain}`,
    };
  }

  return { valid: true };
}

/**
 * Extract the base domain from a potential wildcard
 * *.example.com -> example.com
 * example.com -> example.com
 */
export function getBaseDomain(domain: string): string {
  if (domain.startsWith('*.')) {
    return domain.slice(2);
  }
  return domain;
}

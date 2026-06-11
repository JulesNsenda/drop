/**
 * DNS Challenge Configuration
 *
 * Generates Caddy configuration for DNS-01 ACME challenges.
 * Required for wildcard certificates.
 */

/**
 * Supported DNS providers for ACME DNS-01 challenge
 */
export type DnsProvider = 'cloudflare' | 'route53' | 'digitalocean' | 'godaddy';

/**
 * DNS provider configuration
 */
export interface DnsProviderConfig {
  provider: DnsProvider;
  credentials: {
    apiToken?: string;
    zoneId?: string;
    accessKey?: string;
    secretKey?: string;
  };
}

/**
 * DNS challenge configuration for Caddy
 */
export interface DnsChallengeConfig {
  /** DNS provider module name for Caddy */
  module: string;
  /** Environment variable names for credentials */
  envVars: Record<string, string>;
  /** Caddy TLS block configuration */
  tlsBlock: string;
}

/**
 * Provider-specific configuration
 */
const PROVIDER_CONFIGS: Record<DnsProvider, {
  module: string;
  envVarName: string;
  envVarMapping: Record<string, string>;
}> = {
  cloudflare: {
    module: 'cloudflare',
    envVarName: 'CF_API_TOKEN',
    envVarMapping: {
      apiToken: 'CF_API_TOKEN',
    },
  },
  route53: {
    module: 'route53',
    envVarName: 'AWS_ACCESS_KEY_ID',
    envVarMapping: {
      accessKey: 'AWS_ACCESS_KEY_ID',
      secretKey: 'AWS_SECRET_ACCESS_KEY',
    },
  },
  digitalocean: {
    module: 'digitalocean',
    envVarName: 'DO_AUTH_TOKEN',
    envVarMapping: {
      apiToken: 'DO_AUTH_TOKEN',
    },
  },
  godaddy: {
    module: 'godaddy',
    envVarName: 'GODADDY_API_KEY',
    envVarMapping: {
      apiToken: 'GODADDY_API_KEY',
      secretKey: 'GODADDY_API_SECRET',
    },
  },
};

/**
 * Validate DNS provider credentials
 */
export function validateDnsCredentials(config: DnsProviderConfig): {
  valid: boolean;
  missing: string[];
} {
  const providerConfig = PROVIDER_CONFIGS[config.provider];
  if (!providerConfig) {
    return { valid: false, missing: [`Unknown provider: ${config.provider}`] };
  }

  const missing: string[] = [];

  for (const [credKey, envName] of Object.entries(providerConfig.envVarMapping)) {
    const value = config.credentials[credKey as keyof typeof config.credentials];
    const envValue = process.env[envName];

    if (!value && !envValue) {
      missing.push(envName);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Generate DNS challenge configuration for Caddy
 */
export function generateDnsChallengeConfig(config: DnsProviderConfig): DnsChallengeConfig {
  const providerConfig = PROVIDER_CONFIGS[config.provider];
  if (!providerConfig) {
    throw new Error(`Unknown DNS provider: ${config.provider}`);
  }

  // Build environment variable references
  const envVars: Record<string, string> = {};
  for (const [credKey, envName] of Object.entries(providerConfig.envVarMapping)) {
    const value = config.credentials[credKey as keyof typeof config.credentials];
    if (value) {
      envVars[envName] = value;
    }
  }

  // Generate Caddy TLS block with DNS challenge
  let tlsBlock: string;

  switch (config.provider) {
    case 'cloudflare':
      tlsBlock = `tls {
\tdns cloudflare {env.CF_API_TOKEN}
}`;
      break;

    case 'route53':
      tlsBlock = `tls {
\tdns route53 {
\t\taccess_key_id {env.AWS_ACCESS_KEY_ID}
\t\tsecret_access_key {env.AWS_SECRET_ACCESS_KEY}
\t}
}`;
      break;

    case 'digitalocean':
      tlsBlock = `tls {
\tdns digitalocean {env.DO_AUTH_TOKEN}
}`;
      break;

    case 'godaddy':
      tlsBlock = `tls {
\tdns godaddy {
\t\tapi_token {env.GODADDY_API_KEY} {env.GODADDY_API_SECRET}
\t}
}`;
      break;

    default:
      throw new Error(`Unsupported DNS provider: ${config.provider}`);
  }

  return {
    module: providerConfig.module,
    envVars,
    tlsBlock,
  };
}

/**
 * Generate Caddyfile global options for DNS challenge ACME
 */
export function generateDnsAcmeConfig(
  _provider: DnsProvider,
  email?: string,
  staging?: boolean
): string {
  const lines: string[] = [];

  if (email) {
    lines.push(`\temail ${email}`);
  }

  if (staging) {
    lines.push('\tacme_ca https://acme-staging-v02.api.letsencrypt.org/directory');
  }

  return lines.join('\n');
}

/**
 * Generate a complete TLS directive for a domain with DNS challenge
 */
export function generateTlsDirectiveWithDns(
  provider: DnsProvider,
  isWildcard: boolean = false
): string {
  const providerConfig = PROVIDER_CONFIGS[provider];
  if (!providerConfig) {
    throw new Error(`Unknown DNS provider: ${provider}`);
  }

  // For wildcard certs, we always need DNS-01 challenge
  if (isWildcard) {
    switch (provider) {
      case 'cloudflare':
        return `tls {
\tdns cloudflare {env.CF_API_TOKEN}
}`;

      case 'route53':
        return `tls {
\tdns route53 {
\t\taccess_key_id {env.AWS_ACCESS_KEY_ID}
\t\tsecret_access_key {env.AWS_SECRET_ACCESS_KEY}
\t}
}`;

      case 'digitalocean':
        return `tls {
\tdns digitalocean {env.DO_AUTH_TOKEN}
}`;

      case 'godaddy':
        return `tls {
\tdns godaddy {
\t\tapi_token {env.GODADDY_API_KEY} {env.GODADDY_API_SECRET}
\t}
}`;
    }
  }

  // For regular domains, return empty to use HTTP-01 challenge
  return '';
}

/**
 * Check if a domain requires DNS challenge (wildcards)
 */
export function requiresDnsChallenge(domain: string): boolean {
  return domain.startsWith('*.');
}

/**
 * Get environment variables needed for a DNS provider
 */
export function getRequiredEnvVars(provider: DnsProvider): string[] {
  const providerConfig = PROVIDER_CONFIGS[provider];
  if (!providerConfig) {
    return [];
  }
  return Object.values(providerConfig.envVarMapping);
}

/**
 * Check if required environment variables are set for a provider
 */
export function checkProviderEnvVars(provider: DnsProvider): {
  ready: boolean;
  missing: string[];
  set: string[];
} {
  const required = getRequiredEnvVars(provider);
  const missing: string[] = [];
  const set: string[] = [];

  for (const envVar of required) {
    if (process.env[envVar]) {
      set.push(envVar);
    } else {
      missing.push(envVar);
    }
  }

  return {
    ready: missing.length === 0,
    missing,
    set,
  };
}

import {
  validateDnsCredentials,
  generateDnsChallengeConfig,
  generateTlsDirectiveWithDns,
  requiresDnsChallenge,
  getRequiredEnvVars,
  checkProviderEnvVars,
} from './dns-challenge';

describe('DNS Challenge', () => {
  describe('validateDnsCredentials', () => {
    it('should validate cloudflare credentials from config', () => {
      const result = validateDnsCredentials({
        provider: 'cloudflare',
        credentials: { apiToken: 'test-token' },
      });
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('should report missing credentials', () => {
      const result = validateDnsCredentials({
        provider: 'cloudflare',
        credentials: {},
      });
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('CF_API_TOKEN');
    });

    it('should validate route53 needs both keys', () => {
      const result = validateDnsCredentials({
        provider: 'route53',
        credentials: { accessKey: 'key' },
      });
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('AWS_SECRET_ACCESS_KEY');
    });
  });

  describe('generateDnsChallengeConfig', () => {
    it('should generate cloudflare config', () => {
      const config = generateDnsChallengeConfig({
        provider: 'cloudflare',
        credentials: { apiToken: 'my-token' },
      });
      expect(config.module).toBe('cloudflare');
      expect(config.tlsBlock).toContain('dns cloudflare');
    });

    it('should generate route53 config', () => {
      const config = generateDnsChallengeConfig({
        provider: 'route53',
        credentials: { accessKey: 'ak', secretKey: 'sk' },
      });
      expect(config.module).toBe('route53');
      expect(config.tlsBlock).toContain('dns route53');
    });

    it('should throw for unknown provider', () => {
      expect(() =>
        generateDnsChallengeConfig({
          provider: 'unknown' as any,
          credentials: {},
        })
      ).toThrow('Unknown DNS provider');
    });
  });

  describe('generateTlsDirectiveWithDns', () => {
    it('should generate wildcard TLS directive for cloudflare', () => {
      const result = generateTlsDirectiveWithDns('cloudflare', true);
      expect(result).toContain('dns cloudflare');
    });

    it('should return empty for non-wildcard', () => {
      const result = generateTlsDirectiveWithDns('cloudflare', false);
      expect(result).toBe('');
    });
  });

  describe('requiresDnsChallenge', () => {
    it('should detect wildcard domains', () => {
      expect(requiresDnsChallenge('*.example.com')).toBe(true);
    });

    it('should not flag regular domains', () => {
      expect(requiresDnsChallenge('example.com')).toBe(false);
      expect(requiresDnsChallenge('app.example.com')).toBe(false);
    });
  });

  describe('getRequiredEnvVars', () => {
    it('should return correct env vars for cloudflare', () => {
      expect(getRequiredEnvVars('cloudflare')).toEqual(['CF_API_TOKEN']);
    });

    it('should return correct env vars for route53', () => {
      expect(getRequiredEnvVars('route53')).toEqual([
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
      ]);
    });

    it('should return empty for unknown provider', () => {
      expect(getRequiredEnvVars('unknown' as any)).toEqual([]);
    });
  });

  describe('checkProviderEnvVars', () => {
    it('should report missing env vars', () => {
      const result = checkProviderEnvVars('cloudflare');
      expect(result.ready).toBe(false);
      expect(result.missing).toContain('CF_API_TOKEN');
    });
  });
});

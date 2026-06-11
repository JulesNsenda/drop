import {
  validateDomainFormat,
  isLocalhostDomain,
  validateWildcardDomain,
  getBaseDomain,
  addressMatchesLocal,
} from './domain-validator';

describe('Domain Validator', () => {
  describe('validateDomainFormat', () => {
    it('should accept valid domains', () => {
      expect(validateDomainFormat('example.com')).toBe(true);
      expect(validateDomainFormat('sub.example.com')).toBe(true);
      expect(validateDomainFormat('a.b.c.d.com')).toBe(true);
      expect(validateDomainFormat('my-app.example.com')).toBe(true);
      expect(validateDomainFormat('localhost')).toBe(true);
    });

    it('should reject invalid domains', () => {
      expect(validateDomainFormat('')).toBe(false);
      expect(validateDomainFormat('.example.com')).toBe(false);
      expect(validateDomainFormat('example..com')).toBe(false);
      expect(validateDomainFormat('-example.com')).toBe(false);
      expect(validateDomainFormat('example-.com')).toBe(false);
      expect(validateDomainFormat('a'.repeat(64) + '.com')).toBe(false);
    });

    it('should reject non-string input', () => {
      expect(validateDomainFormat(null as any)).toBe(false);
      expect(validateDomainFormat(undefined as any)).toBe(false);
    });
  });

  describe('isLocalhostDomain', () => {
    it('should detect localhost domains', () => {
      expect(isLocalhostDomain('localhost')).toBe(true);
      expect(isLocalhostDomain('myapp.localhost')).toBe(true);
      expect(isLocalhostDomain('127.0.0.1')).toBe(true);
    });

    it('should not flag non-localhost domains', () => {
      expect(isLocalhostDomain('example.com')).toBe(false);
      expect(isLocalhostDomain('localhost.example.com')).toBe(false);
    });
  });

  describe('validateWildcardDomain', () => {
    it('should accept valid wildcards', () => {
      expect(validateWildcardDomain('*.example.com').valid).toBe(true);
    });

    it('should reject invalid wildcards', () => {
      expect(validateWildcardDomain('example.com').valid).toBe(false);
      expect(validateWildcardDomain('*.').valid).toBe(false);
    });
  });

  describe('getBaseDomain', () => {
    it('should strip wildcard prefix', () => {
      expect(getBaseDomain('*.example.com')).toBe('example.com');
    });

    it('should return non-wildcard domains as-is', () => {
      expect(getBaseDomain('example.com')).toBe('example.com');
    });
  });

  describe('addressMatchesLocal', () => {
    it('should match when IPs overlap', () => {
      expect(addressMatchesLocal(['1.2.3.4'], ['1.2.3.4', '5.6.7.8'])).toBe(true);
    });

    it('should not match when IPs differ', () => {
      expect(addressMatchesLocal(['9.9.9.9'], ['1.2.3.4'])).toBe(false);
    });

    it('should be case-insensitive for IPv6', () => {
      expect(addressMatchesLocal(['::FFFF'], ['::ffff'])).toBe(true);
    });
  });
});

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  parseDropYaml,
  findDropYaml,
  validateDropYamlConfig,
  mergeWithDefaults,
  getCustomDomains,
} from './drop-yaml-parser';

describe('Drop YAML Parser', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-yaml-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('findDropYaml', () => {
    it('should find drop.yaml', async () => {
      await fs.writeFile(path.join(tmpDir, 'drop.yaml'), 'name: test');
      const result = await findDropYaml(tmpDir);
      expect(result).toBe(path.join(tmpDir, 'drop.yaml'));
    });

    it('should find drop.yml', async () => {
      await fs.writeFile(path.join(tmpDir, 'drop.yml'), 'name: test');
      const result = await findDropYaml(tmpDir);
      expect(result).toBe(path.join(tmpDir, 'drop.yml'));
    });

    it('should return null when no file exists', async () => {
      const result = await findDropYaml(tmpDir);
      expect(result).toBeNull();
    });
  });

  describe('parseDropYaml', () => {
    it('should parse a valid drop.yaml', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'drop.yaml'),
        'name: my-app\ndomains:\n  - example.com\n  - www.example.com\nport: 8080'
      );

      const result = await parseDropYaml(tmpDir);
      expect(result.success).toBe(true);
      expect(result.exists).toBe(true);
      expect(result.config?.name).toBe('my-app');
      expect(result.config?.domains).toEqual(['example.com', 'www.example.com']);
      expect(result.config?.port).toBe(8080);
    });

    it('should handle missing drop.yaml gracefully', async () => {
      const result = await parseDropYaml(tmpDir);
      expect(result.success).toBe(true);
      expect(result.exists).toBe(false);
      expect(result.config).toBeNull();
    });

    it('should report invalid YAML', async () => {
      await fs.writeFile(path.join(tmpDir, 'drop.yaml'), '{{invalid yaml');
      const result = await parseDropYaml(tmpDir);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should validate domains', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'drop.yaml'),
        'domains:\n  - "invalid domain!!"'
      );
      const result = await parseDropYaml(tmpDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid domain');
    });

    it('should parse build_env alongside env', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'drop.yaml'),
        'env:\n  NODE_ENV: production\nbuild_env:\n  VITE_API_URL: ""\n  VITE_PORT: 5173'
      );
      const result = await parseDropYaml(tmpDir);
      expect(result.success).toBe(true);
      expect(result.config?.env).toEqual({ NODE_ENV: 'production' });
      expect(result.config?.build_env).toEqual({ VITE_API_URL: '', VITE_PORT: 5173 });
    });

    it('should reject invalid build_env values from a real file', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'drop.yaml'),
        'build_env:\n  BAD: [1, 2, 3]'
      );
      const result = await parseDropYaml(tmpDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('build_env.BAD');
    });
  });

  describe('validateDropYamlConfig', () => {
    it('should accept null/undefined config', () => {
      expect(validateDropYamlConfig(null).valid).toBe(true);
      expect(validateDropYamlConfig(undefined).valid).toBe(true);
    });

    it('should reject non-object config', () => {
      expect(validateDropYamlConfig('string').valid).toBe(false);
    });

    it('should reject invalid port', () => {
      expect(validateDropYamlConfig({ port: -1 }).valid).toBe(false);
      expect(validateDropYamlConfig({ port: 99999 }).valid).toBe(false);
    });

    it('should validate depends_on structure', () => {
      const valid = validateDropYamlConfig({
        depends_on: [{ name: 'api', env: 'API_URL' }],
      });
      expect(valid.valid).toBe(true);

      const invalid = validateDropYamlConfig({
        depends_on: [{ name: 123 }],
      });
      expect(invalid.valid).toBe(false);
    });

    it('should accept build_env with string, number, and boolean values', () => {
      const result = validateDropYamlConfig({
        build_env: {
          VITE_API_URL: '/api',
          VITE_PORT: 5173,
          VITE_DEBUG: true,
        },
      });
      expect(result.valid).toBe(true);
    });

    it('should reject build_env that is not an object', () => {
      expect(validateDropYamlConfig({ build_env: 'nope' }).valid).toBe(false);
      expect(validateDropYamlConfig({ build_env: ['nope'] }).valid).toBe(false);
    });

    it('should reject build_env values of the wrong type', () => {
      const result = validateDropYamlConfig({
        build_env: { VITE_CONFIG: { nested: true } },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('build_env.VITE_CONFIG');
    });

    it('should reject build_env with non-string keys via empty key', () => {
      const result = validateDropYamlConfig({
        build_env: { '': 'value' },
      });
      expect(result.valid).toBe(false);
    });

    it('should no longer reject build_env as an unknown top-level field', () => {
      const result = validateDropYamlConfig({ build_env: { FOO: 'bar' } });
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('mergeWithDefaults', () => {
    it('should use drop.yaml values when present', () => {
      const result = mergeWithDefaults(
        { name: 'custom', domains: ['custom.com'], port: 9090 },
        { name: 'default', hostname: 'default.localhost', port: 3000 }
      );
      expect(result.name).toBe('custom');
      expect(result.domains).toEqual(['custom.com']);
      expect(result.port).toBe(9090);
    });

    it('should fall back to defaults when no drop.yaml', () => {
      const result = mergeWithDefaults(null, {
        name: 'myapp',
        hostname: 'myapp.localhost',
        port: 3000,
      });
      expect(result.name).toBe('myapp');
      expect(result.domains).toEqual(['myapp.localhost']);
      expect(result.port).toBe(3000);
    });
  });

  describe('getCustomDomains', () => {
    it('should return domains from drop.yaml', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'drop.yaml'),
        'domains:\n  - myapp.com\n  - www.myapp.com'
      );
      const domains = await getCustomDomains(tmpDir);
      expect(domains).toEqual(['myapp.com', 'www.myapp.com']);
    });

    it('should return null when no domains configured', async () => {
      await fs.writeFile(path.join(tmpDir, 'drop.yaml'), 'name: test');
      const domains = await getCustomDomains(tmpDir);
      expect(domains).toBeNull();
    });

    it('should return null when no drop.yaml', async () => {
      const domains = await getCustomDomains(tmpDir);
      expect(domains).toBeNull();
    });
  });
});

import { buildNginxConf } from './nginx-conf';

describe('buildNginxConf', () => {
  it('includes the specified port in listen directive', () => {
    const conf = buildNginxConf(8080, '');
    expect(conf).toContain('listen 8080;');
  });

  it('uses /app as root when outputSubdir is empty', () => {
    const conf = buildNginxConf(3000, '');
    expect(conf).toContain('root /app;');
  });

  it('appends outputSubdir to root path', () => {
    const conf = buildNginxConf(3000, 'dist');
    expect(conf).toContain('root /app/dist;');
  });

  it('handles nested outputSubdir', () => {
    const conf = buildNginxConf(3000, 'public/build');
    expect(conf).toContain('root /app/public/build;');
  });

  it('includes SPA try_files fallback', () => {
    const conf = buildNginxConf(4000, 'build');
    expect(conf).toContain('try_files $uri $uri/ /index.html;');
  });

  it('includes gzip compression', () => {
    const conf = buildNginxConf(4000, '');
    expect(conf).toContain('gzip on;');
  });

  it('produces a valid server block structure', () => {
    const conf = buildNginxConf(5000, 'dist');
    expect(conf.trim()).toMatch(/^server \{[\s\S]+\}$/);
  });
});

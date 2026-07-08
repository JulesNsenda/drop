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

  it('produces a full config with events and http blocks', () => {
    const conf = buildNginxConf(5000, 'dist');
    expect(conf).toMatch(/events \{[\s\S]+\}/);
    expect(conf).toMatch(/http \{[\s\S]+server \{[\s\S]+\}[\s\S]+\}/);
  });

  it('is runnable unprivileged: pid and temp paths under /tmp, no user directive', () => {
    const conf = buildNginxConf(3000, '');
    expect(conf).toContain('pid /tmp/nginx.pid;');
    expect(conf).toContain('client_body_temp_path /tmp/client_temp;');
    expect(conf).toContain('proxy_temp_path /tmp/proxy_temp;');
    expect(conf).not.toMatch(/^\s*user /m);
  });

  it('logs to stdout/stderr so the container log tailer captures them', () => {
    const conf = buildNginxConf(3000, '');
    expect(conf).toContain('error_log stderr warn;');
    expect(conf).toContain('access_log /dev/stdout;');
  });
});

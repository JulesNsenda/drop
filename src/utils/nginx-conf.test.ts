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

  /**
   * A plain-root static app's document root IS the app directory, so `.git/`
   * and `.env` sit under it and `try_files $uri` served them. Measured against
   * real nginx:alpine before the fix: `GET /.git/config` returned 200 with the
   * PAT in the body, `GET /.env` returned 200 with the secret.
   *
   * These are string assertions on a generated config, which cannot prove
   * nginx's behaviour — the behavioural proof is the docker run recorded in
   * the PR. What they DO protect is the shape: that the block exists at all,
   * and that it stays ahead of `location /`.
   */
  describe('dotfiles are not served', () => {
    it('emits a dotfile location that 404s rather than 403s', () => {
      const conf = buildNginxConf(3000, '');
      expect(conf).toContain('location ~ /\\.(?!well-known/) {');
      // 404, not `deny all`'s 403 — a 403 confirms the file exists.
      expect(conf).toMatch(/location ~ \/\\\.\(\?!well-known\/\) \{\s*\n\s*return 404;/);
      expect(conf).not.toContain('deny all');
    });

    it('carves out .well-known, which is legitimately public', () => {
      // security.txt / apple-app-site-association / assetlinks.json live
      // there. A bare `location ~ /\.` would 404 them.
      expect(buildNginxConf(3000, '')).toContain('(?!well-known/)');
    });

    it('puts the dotfile rule BEFORE location /', () => {
      // Not cosmetic. nginx picks the first MATCHING regex location, and a
      // regex location beats the `location /` prefix match — but if a future
      // edit turns the dotfile rule into a prefix location, ordering becomes
      // load-bearing and this pins it.
      const conf = buildNginxConf(3000, '');
      expect(conf.indexOf('location ~ /\\.')).toBeLessThan(conf.indexOf('location / {'));
      expect(conf.indexOf('location ~ /\\.')).toBeGreaterThan(-1);
    });

    it('applies to an SPA subdir config too, not just a plain root', () => {
      // An SPA's root is /app/<subdir>, so .git is outside it and was never
      // exposed — which is exactly why this went unnoticed. Emit the rule
      // anyway: the app dir is one `outputDirectory: '.'` away.
      expect(buildNginxConf(3000, 'dist')).toContain('location ~ /\\.(?!well-known/) {');
    });
  });
});

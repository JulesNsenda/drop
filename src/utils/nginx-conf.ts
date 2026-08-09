/**
 * Nginx configuration builder for static/SPA apps in Docker mode (Tier B).
 *
 * DROP serves static apps via nginx:alpine in container mode.  The generated
 * file is a COMPLETE nginx.conf (not a conf.d server block): the container
 * runs nginx as the unprivileged `nginx` user (uid 101) with zero Linux
 * capabilities, so the config must avoid everything that needs root:
 *
 * - no `user` directive (only meaningful for a root master),
 * - pid + all temp paths under /tmp (the default /var/cache/nginx/* dirs
 *   would need a chown, which is what crash-looped Tier A under CapDrop ALL),
 * - logs to stdout/stderr so DROP's log tailer captures them.
 *
 * The conf is written to the app's data dir (bind-mounted read-write inside
 * the container at the same absolute path) and passed via `nginx -c`.
 */

/**
 * Build a full unprivileged nginx.conf for a static/SPA app.
 *
 * @param port       The host port assigned by DROP (nginx will listen here).
 * @param outputSubdir  The build output directory relative to the app root
 *                    (e.g. `"dist"`, `"build"`, `""` for the root).
 *
 * SPA routing: uses `try_files $uri $uri/ /index.html` so that client-side
 * routers (React Router, Vue Router, etc.) work without 404s.
 */
export function buildNginxConf(port: number, outputSubdir: string): string {
  const root = outputSubdir ? `/app/${outputSubdir}` : '/app';

  return [
    `worker_processes 1;`,
    `pid /tmp/nginx.pid;`,
    `error_log stderr warn;`,
    ``,
    `events {`,
    `    worker_connections 1024;`,
    `}`,
    ``,
    `http {`,
    `    include /etc/nginx/mime.types;`,
    `    default_type application/octet-stream;`,
    `    access_log /dev/stdout;`,
    `    sendfile on;`,
    ``,
    `    client_body_temp_path /tmp/client_temp;`,
    `    proxy_temp_path /tmp/proxy_temp;`,
    `    fastcgi_temp_path /tmp/fastcgi_temp;`,
    `    uwsgi_temp_path /tmp/uwsgi_temp;`,
    `    scgi_temp_path /tmp/scgi_temp;`,
    ``,
    `    server {`,
    `        listen ${port};`,
    `        root ${root};`,
    `        index index.html index.htm;`,
    ``,
    // Dotfiles are never web content, and for a PLAIN-ROOT static app the
    // document root IS the app directory — so `.git/` and `.env` sit directly
    // under it and `try_files $uri` below would happily serve them. A
    // git-deployed static app therefore published its full history, and (for
    // any app cloned before the DROP-142 credential fix) the PAT baked into
    // `.git/config`, at `https://<app>/.git/config`.
    //
    // An SPA is not affected — its root is `/app/<outputSubdir>`, so `.git`
    // sits outside the document root entirely. That asymmetry is why this went
    // unnoticed: the SPA case, which is most apps, was always safe.
    //
    // 404 rather than `deny all`'s 403: a 403 confirms the file is there,
    // which is the existence oracle the rest of the platform avoids.
    //
    // `.well-known` is carved out because it is legitimately public content
    // (security.txt, apple-app-site-association, assetlinks.json). The
    // negative lookahead needs a PCRE-enabled nginx; nginx:alpine, the only
    // image this conf is ever used with, is built with PCRE.
    `        location ~ /\\.(?!well-known/) {`,
    `            return 404;`,
    `        }`,
    ``,
    `        location / {`,
    `            try_files $uri $uri/ /index.html;`,
    `        }`,
    ``,
    `        gzip on;`,
    `        gzip_types text/plain text/css application/json application/javascript`,
    `                   text/xml application/xml text/javascript;`,
    `    }`,
    `}`,
    ``,
  ].join('\n');
}

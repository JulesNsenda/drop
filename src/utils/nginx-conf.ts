/**
 * Nginx configuration builder for static/SPA apps in Docker mode (M2f).
 *
 * DROP serves static apps via nginx:alpine in container mode.  The generated
 * conf is written to the app's data dir (bind-mounted read-write inside the
 * container) and copied to /etc/nginx/conf.d/default.conf at container start,
 * overriding the default port-80 server block.
 */

/**
 * Build a minimal nginx server block for a static/SPA app.
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
    `server {`,
    `    listen ${port};`,
    `    root ${root};`,
    `    index index.html index.htm;`,
    ``,
    `    location / {`,
    `        try_files $uri $uri/ /index.html;`,
    `    }`,
    ``,
    `    gzip on;`,
    `    gzip_types text/plain text/css application/json application/javascript`,
    `               text/xml application/xml text/javascript;`,
    `}`,
    ``,
  ].join('\n');
}

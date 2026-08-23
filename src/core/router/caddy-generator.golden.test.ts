/**
 * Byte-exact Caddyfile output for every route shape the platform emits today.
 *
 * These are deliberately GOLDEN STRINGS rather than structural assertions, and
 * they exist for one job: the access gate (DROP-152 Slice 1b) restructures
 * `generateRouteBlock`, and the question "does that change what any existing
 * app gets?" has to be answerable by a red test rather than by an argument.
 * The last time this repo changed guard composition, the reasoning was right
 * and still needed measuring against a real Caddy.
 *
 * So: if a diff turns one of these red, that is the signal — either the change
 * was meant to alter emitted config for that shape, or it was not and this
 * caught it. Never "update the golden to match"; work out which case it is
 * first.
 *
 * The shapes below are the ones the platform actually produces
 * (`handleConfigureRoute`), plus `staticPath`, which it never sets but the
 * generator still supports.
 */

import { generateRouteBlock } from './caddy-generator';
import { RouteConfig } from './router.types';

/** Render a block the way `generateCaddyfile` does, so the golden is real output. */
function render(route: RouteConfig, isLocalhost = false): string {
  const block = generateRouteBlock(route, isLocalhost);
  const lines: string[] = [`${block.address} {`];
  const emit = (d: { name: string; args?: string[]; block?: unknown[] }, depth: number): void => {
    const pad = '\t'.repeat(depth);
    const args = d.args?.join(' ') ?? '';
    const head = args ? `${pad}${d.name} ${args}` : `${pad}${d.name}`;
    if (!d.block || d.block.length === 0) {
      lines.push(head);
      return;
    }
    lines.push(`${head} {`);
    for (const child of d.block) emit(child as never, depth + 1);
    lines.push(`${pad}}`);
  };
  for (const d of block.directives) emit(d as never, 1);
  lines.push('}');
  return lines.join('\n');
}

/** The security headers `handleConfigureRoute` injects under docker isolation. */
const TENANT_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const base: RouteConfig = {
  appName: 'myapp-myapp-dropkit-sh',
  owner: 'myapp',
  hostname: 'myapp.dropkit.sh',
  upstream: 'localhost:4000',
  ssl: true,
  redirectHttps: true,
  headers: TENANT_HEADERS,
  tls: { auto: true },
};

const mcpAuth = { path: '/mcp', appName: 'myapp', verifyUpstream: '127.0.0.1:3000' };

describe('emitted Caddyfile — golden', () => {
  it('plain app', () => {
    expect(render(base)).toBe(
      `myapp.dropkit.sh {
	encode gzip zstd
	header {
		X-Frame-Options SAMEORIGIN
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		Permissions-Policy camera=(), microphone=(), geolocation=()
	}
	reverse_proxy localhost:4000
}`
    );
  });

  it('app with a DROP-guarded MCP endpoint', () => {
    // The `route` inside the `handle` is load-bearing: Caddy sorts `handle`
    // children by its own table and `forward_auth` sorts BEFORE
    // `request_header`, so written as a bare list the identity strips would run
    // AFTER the auth sub-request and delete what copy_headers just set.
    expect(render({ ...base, mcpAuth })).toBe(
      `myapp.dropkit.sh {
	encode gzip zstd
	header {
		X-Frame-Options SAMEORIGIN
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		Permissions-Policy camera=(), microphone=(), geolocation=()
	}
	handle /mcp* {
		route {
			request_header -X-Drop-User-Id
			request_header -X-Drop-Username
			forward_auth 127.0.0.1:3000 {
				uri /api/v1/mcp-gateway/verify?app=myapp
				copy_headers X-Drop-User-Id X-Drop-Username
			}
			reverse_proxy localhost:4000 {
				header_up -Authorization
				header_up -X-Api-Key
			}
		}
	}
	handle {
		reverse_proxy localhost:4000
	}
}`
    );
  });

  it('monorepo child on a shared host with a path prefix', () => {
    // The matcher folds in the site address's own prefix — a bare `/mcp*` on a
    // `group.host/api*` block could never match, and every request including
    // the guarded one would fall through to the catch-all.
    expect(render({ ...base, hostname: 'ezsign.dropkit.sh', pathPrefix: '/api*', mcpAuth })).toBe(
      `ezsign.dropkit.sh/api* {
	encode gzip zstd
	header {
		X-Frame-Options SAMEORIGIN
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		Permissions-Policy camera=(), microphone=(), geolocation=()
	}
	handle /api/mcp* {
		route {
			request_header -X-Drop-User-Id
			request_header -X-Drop-Username
			forward_auth 127.0.0.1:3000 {
				uri /api/v1/mcp-gateway/verify?app=myapp
				copy_headers X-Drop-User-Id X-Drop-Username
			}
			reverse_proxy localhost:4000 {
				header_up -Authorization
				header_up -X-Api-Key
			}
		}
	}
	handle {
		reverse_proxy localhost:4000
	}
}`
    );
  });

  it('localhost app (no TLS directive, no HTTPS)', () => {
    expect(render({ ...base, hostname: 'myapp.localhost', ssl: false }, true)).toBe(
      `myapp.localhost {
	encode gzip zstd
	header {
		X-Frame-Options SAMEORIGIN
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		Permissions-Policy camera=(), microphone=(), geolocation=()
	}
	reverse_proxy localhost:4000
}`
    );
  });

  it('custom TLS certificates', () => {
    expect(
      render({ ...base, headers: undefined, tls: { certFile: '/c.pem', keyFile: '/k.pem' } })
    ).toBe(
      `myapp.dropkit.sh {
	tls /c.pem /k.pem
	encode gzip zstd
	reverse_proxy localhost:4000
}`
    );
  });

  it('staticPath (generator-only — the platform never sets it)', () => {
    // Kept golden so the dead branch cannot change shape unnoticed. Measured
    // against Caddy 2.11.4: a bare `file_server` beside a match-all guard
    // `handle` is dead config, not a bypass — `handle` sorts first and is
    // terminal.
    expect(render({ ...base, headers: undefined, staticPath: '/srv/myapp' })).toBe(
      `myapp.dropkit.sh {
	encode gzip zstd
	root * /srv/myapp
	file_server
	reverse_proxy localhost:4000
}`
    );
  });
});

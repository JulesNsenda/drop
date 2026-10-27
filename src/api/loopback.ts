/**
 * Whether a request reached the API directly from this machine.
 *
 * The platform's own CLI key is meant for the operator at the machine's own
 * terminal. A reverse proxy (Caddy) on the same host also connects from
 * loopback, and everything the internet sends arrives that way, so "the peer
 * is 127.0.0.1" alone proves nothing: a request that was proxied carries
 * forwarding headers, and one that carries them is refused here whatever their
 * value. Fails closed when the peer address cannot be read.
 */

import type { Context } from 'hono';

/** Headers a proxy adds. Their mere presence marks the request as forwarded. */
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via'];

export function isDirectLoopbackRequest(c: Context): boolean {
  const incoming = (c.env as unknown as Record<string, unknown> | undefined)?.incoming as
    | { socket?: { remoteAddress?: string } }
    | undefined;
  const peer = incoming?.socket?.remoteAddress?.replace(/^::ffff:/i, '');
  if (peer !== '127.0.0.1' && peer !== '::1') return false;
  return !FORWARDING_HEADERS.some((header) => c.req.header(header) !== undefined);
}

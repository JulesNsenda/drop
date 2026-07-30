/**
 * Connection-string construction (DROP-066 lives in this code path).
 *
 * A single pure builder so there is one percent-encoding implementation
 * rather than a second inline copy that drifts. Extracted out of
 * `database-provisioner.ts`'s `getEnvVars` — behaviour is byte-identical to
 * what that method built inline; see its tests for the regression coverage.
 */

export type ConnectionTarget = { kind: 'tcp'; host: string } | { kind: 'socket'; dir: string };

/**
 * Build a `postgresql://` connection string for the given credentials and
 * target. Two deliberately different encodings, kept exactly as they were
 * inline — do NOT unify them, that would change every existing app's
 * DATABASE_URL:
 *
 * - `tcp`: password is NOT percent-encoded.
 * - `socket`: password IS percent-encoded (see the socket-form rationale
 *   below).
 */
export function buildConnectionString(
  creds: { user: string; password: string; port: number; database: string },
  target: ConnectionTarget
): string {
  if (target.kind === 'socket') {
    // libpq socket URI with the socket directory percent-encoded IN the host
    // (authority) position, e.g.
    //   postgresql://user:pw@%2Fvar%2Frun%2Fpg:5432/dbname
    //
    // This is the ONLY unix-socket URL form that is BOTH:
    //   * WHATWG-parseable — `new URL()` accepts it, so a Node app that
    //     validates DATABASE_URL with the URL constructor (or with
    //     pg-connection-string, which `pg` and `node-pg-migrate` use) does
    //     not reject it; and
    //   * correctly decoded — pg-connection-string, psycopg, and libpq turn
    //     the percent-encoded host back into the socket path and connect
    //     over the socket (the ':<port>' selects the .s.PGSQL.<port> file).
    //
    // The older `postgresql://user:pw/db?host=<dir>&port=<n>` form has NO
    // '@', which makes `new URL()` throw ERR_INVALID_URL and crash-loops
    // Node apps at startup (only Python/libpq clients tolerated it, which is
    // why it slipped through). See DROP-066.
    const pw = encodeURIComponent(creds.password);
    return (
      `postgresql://${creds.user}:${pw}` +
      `@${encodeURIComponent(target.dir)}:${creds.port}/${creds.database}`
    );
  }

  return `postgresql://${creds.user}:${creds.password}@${target.host}:${creds.port}/${creds.database}`;
}

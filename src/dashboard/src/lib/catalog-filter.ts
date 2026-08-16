/**
 * Search/kind filter over the extension catalog (`GET /api/v1/extensions`,
 * DROP-151 Phase 1).
 *
 * The dashboard is a separate npm package from the server (see root
 * `CLAUDE.md`), so this file does NOT import `src/api/routes/extensions.ts` —
 * it declares its own copy of the wire shape, same as `redeploy-credential.ts`
 * and `db-format.ts` do for their routes. Keep the two in sync by hand if the
 * route's descriptor shape changes.
 *
 * Deliberately free of React so it runs under the root jest project
 * (`testEnvironment: 'node'`, `testMatch: ['**\/*.test.ts']`) — this package
 * has no test runner of its own.
 *
 * Matching semantics mirror `AppsPage.tsx:143-155`'s app-list filter:
 * case-insensitive substring, and here additionally trimmed so a search box
 * that only has leading/trailing whitespace behaves like an empty one instead
 * of matching nothing.
 */

export type ExtensionKind = 'service' | 'apptype';

export type ExtensionUnavailableReason = 'postgres-not-ready' | 'redis-not-ready';

export interface ExtensionDescriptor {
  id: string;
  kind: ExtensionKind;
  displayName: string;
  summary: string;
  keywords: string[];
  docsUrl?: string;
  /**
   * Services only. App-type cards deliberately ship no snippet — a bare
   * `type:` fragment short-circuits detection and downgrades the start command
   * to `node index.js`; see the long comment on `snippet` in
   * `src/api/routes/extensions.ts`, which the server pins with a test.
   */
  snippet?: string;
  /** App types only: how DROP recognises this kind of app, in one line. */
  detection?: string;
  availability: 'available' | 'unavailable';
  unavailableReason?: ExtensionUnavailableReason;
}

export interface CatalogFilter {
  search: string;
  kind: ExtensionKind | 'all';
}

/**
 * Filters the catalog by kind and by a case-insensitive substring search over
 * `displayName`, `summary` AND `keywords` — keywords matter because a card's
 * displayed name and summary don't have to contain the term a user searches
 * for (e.g. "cache" should find Redis via its keywords even though neither
 * `displayName` nor `summary` says the word).
 */
export function filterCatalog(
  descriptors: ExtensionDescriptor[],
  filter: CatalogFilter
): ExtensionDescriptor[] {
  const search = filter.search.trim().toLowerCase();

  return descriptors.filter(descriptor => {
    const matchesKind = filter.kind === 'all' || descriptor.kind === filter.kind;

    const matchesSearch =
      !search ||
      descriptor.displayName.toLowerCase().includes(search) ||
      descriptor.summary.toLowerCase().includes(search) ||
      descriptor.keywords.some(keyword => keyword.toLowerCase().includes(search));

    return matchesKind && matchesSearch;
  });
}

import { filterCatalog, type ExtensionDescriptor } from './catalog-filter';

const descriptor = (over: Partial<ExtensionDescriptor> = {}): ExtensionDescriptor => ({
  id: 'postgres',
  kind: 'service',
  displayName: 'PostgreSQL',
  summary: 'A managed relational database, provisioned per app.',
  keywords: ['sql', 'relational', 'database'],
  availability: 'available',
  ...over,
});

const CATALOG: ExtensionDescriptor[] = [
  descriptor({
    id: 'postgres',
    kind: 'service',
    displayName: 'PostgreSQL',
    summary: 'A managed relational database, provisioned per app.',
    keywords: ['sql', 'relational', 'database'],
  }),
  descriptor({
    id: 'redis',
    kind: 'service',
    displayName: 'Redis',
    summary: 'An in-memory store for sessions, queues and rate limits.',
    keywords: ['cache', 'queue', 'sessions'],
  }),
  descriptor({
    id: 'nodejs',
    kind: 'apptype',
    displayName: 'Node.js',
    summary: 'Detected from package.json.',
    keywords: ['javascript', 'typescript', 'npm'],
  }),
];

describe('filterCatalog', () => {
  it('returns everything for an empty search and kind "all"', () => {
    const result = filterCatalog(CATALOG, { search: '', kind: 'all' });
    expect(result).toHaveLength(3);
  });

  it('filters by kind alone', () => {
    const result = filterCatalog(CATALOG, { search: '', kind: 'service' });
    expect(result.map(d => d.id)).toEqual(['postgres', 'redis']);
  });

  it('matches on displayName', () => {
    const result = filterCatalog(CATALOG, { search: 'Postgre', kind: 'all' });
    expect(result.map(d => d.id)).toEqual(['postgres']);
  });

  it('matches on summary', () => {
    const result = filterCatalog(CATALOG, { search: 'rate limits', kind: 'all' });
    expect(result.map(d => d.id)).toEqual(['redis']);
  });

  /**
   * The case a naive displayName-only filter would miss: "cache" appears in
   * Redis's keywords, not in its displayName or summary.
   */
  it('matches on a keyword the name and summary do not contain', () => {
    const result = filterCatalog(CATALOG, { search: 'cache', kind: 'all' });
    expect(result.map(d => d.id)).toEqual(['redis']);
  });

  it('is case-insensitive', () => {
    const result = filterCatalog(CATALOG, { search: 'POSTGRE', kind: 'all' });
    expect(result.map(d => d.id)).toEqual(['postgres']);
  });

  it('treats a whitespace-only search as no search at all', () => {
    const result = filterCatalog(CATALOG, { search: '   ', kind: 'all' });
    expect(result).toHaveLength(3);
  });

  it('trims surrounding whitespace before matching', () => {
    const result = filterCatalog(CATALOG, { search: '  redis  ', kind: 'all' });
    expect(result.map(d => d.id)).toEqual(['redis']);
  });

  it('returns nothing when search and kind both fail to match', () => {
    const result = filterCatalog(CATALOG, { search: 'mysql', kind: 'all' });
    expect(result).toEqual([]);
  });

  it('combines search and kind — a match on kind alone is not enough', () => {
    const result = filterCatalog(CATALOG, { search: 'cache', kind: 'apptype' });
    expect(result).toEqual([]);
  });

  it('combines search and kind — both must pass', () => {
    const result = filterCatalog(CATALOG, { search: 'javascript', kind: 'apptype' });
    expect(result.map(d => d.id)).toEqual(['nodejs']);
  });
});

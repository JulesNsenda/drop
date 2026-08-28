import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, Filter, Package, RefreshCw, Search } from 'lucide-react';
import { apiJson } from '../api/client';
import { useToast } from '../components/Toast';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import EmptyState from '../components/ui/EmptyState';
import { describeAvailability } from '../lib/availability-label';
import {
  filterCatalog,
  type CatalogFilter,
  type ExtensionDescriptor,
  type ExtensionKind,
} from '../lib/catalog-filter';

const KIND_OPTIONS: { value: ExtensionKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'service', label: 'Services' },
  { value: 'apptype', label: 'App types' },
];

/** A single catalog entry. Read-only by design (DROP-151 Phase 1) — there is
 * no `:name` on this route and no app-picker anywhere in the dashboard, so
 * every action here is "how to add this", never an action that adds it. */
/**
 * `navigator.clipboard` is undefined outside a secure context, and plain-HTTP
 * DROP installs (http://host:3000/dashboard) are an ordinary deployment shape
 * — so on those boxes every Copy click would throw. The `<pre>` is selectable
 * either way, so hide the button rather than ship an affordance that only
 * ever errors.
 */
const CAN_COPY = typeof navigator !== 'undefined' && !!navigator.clipboard;

/**
 * React does NOT block `javascript:` in an `href`, and this component trusts a
 * URL that arrived over the wire against a locally-declared copy of the server
 * type — the two can drift. An http(s) allowlist is the cheap invariant; the
 * link simply does not render otherwise.
 */
function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function ExtensionCard({ extension }: { extension: ExtensionDescriptor }) {
  const { toast } = useToast();
  const availability = describeAvailability(extension);

  const handleCopy = async () => {
    if (!extension.snippet) return;
    try {
      await navigator.clipboard.writeText(extension.snippet);
      toast('success', 'Snippet copied to clipboard');
    } catch {
      toast('error', 'Could not copy automatically — select and copy the snippet manually');
    }
  };

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold" style={{ color: 'var(--text)' }}>
            {extension.displayName}
          </h3>
          <Badge tone="neutral" className="mt-1">
            {extension.kind === 'service' ? 'Service' : 'App type'}
          </Badge>
        </div>
        <Badge tone={availability.tone}>{availability.label}</Badge>
      </div>

      <p className="text-sm" style={{ color: 'var(--text-2)' }}>
        {extension.summary}
      </p>

      <p className="text-sm" style={{ color: 'var(--text-3)' }}>
        {availability.detail}
      </p>

      {/* `canAdd` — not just the presence of a snippet — gates this section:
          describeAvailability() decides whether the Add affordance should
          render, not this component. */}
      {availability.canAdd && extension.snippet && (
        <div>
          <span className="mb-1 block text-xs font-medium uppercase" style={{ color: 'var(--text-3)' }}>
            drop.yaml
          </span>
          <pre
            className="overflow-x-auto rounded-lg p-3 text-xs"
            style={{ background: 'var(--bg-2)', color: 'var(--text)' }}
          >
            <code>{extension.snippet}</code>
          </pre>
          {CAN_COPY && (
            <Button
              type="button"
              variant="secondary"
              className="mt-2"
              onClick={() => void handleCopy()}
            >
              <Copy className="h-4 w-4" />
              Copy
            </Button>
          )}
        </div>
      )}

      {/* App types ship no snippet by design — this is their equivalent, and
          the honest answer to "how do I use this?" when the answer is
          "nothing to do". */}
      {extension.detection && (
        <p className="text-sm" style={{ color: 'var(--text-2)' }}>
          {extension.detection}
        </p>
      )}

      {extension.docsUrl && isSafeHttpUrl(extension.docsUrl) && (
        <a
          href={extension.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm hover:underline"
          style={{ color: 'var(--accent)' }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Docs
        </a>
      )}
    </Card>
  );
}

/**
 * Extension catalog (DROP-151 Phase 1): browse the backing services and app
 * types DROP can build, with a copy-pasteable drop.yaml snippet as the "Add".
 * Static, in-tree data — a one-shot fetch, not a poll (see the doc comment on
 * `usePolledJson` in hooks/useApi.ts, and DatabaseTab.tsx's "On-demand
 * refresh only" for the same reasoning against a shared backing store).
 */
function CatalogPage() {
  const [extensions, setExtensions] = useState<ExtensionDescriptor[]>([]);
  // First-load-only, same contract `usePolledJson` documents: never re-raised
  // by a manual refresh, or the DROP-149 flicker bug comes back.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<ExtensionKind | 'all'>('all');

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    const json = await apiJson<{ extensions: ExtensionDescriptor[] }>('/extensions');
    if (json.success && json.data) {
      setExtensions(json.data.extensions);
      setError(null);
    } else {
      setError(json.error?.message || 'Failed to load the catalog');
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const filter: CatalogFilter = useMemo(() => ({ search, kind }), [search, kind]);
  const filtered = useMemo(() => filterCatalog(extensions, filter), [extensions, filter]);

  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = { all: extensions.length };
    for (const ext of extensions) counts[ext.kind] = (counts[ext.kind] || 0) + 1;
    return counts;
  }, [extensions]);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>
            Catalog
          </h1>
          <p style={{ color: 'var(--text-2)' }}>
            Backing services and app types DROP can build. Copy a snippet into your app&apos;s
            drop.yaml to use one.
          </p>
        </div>
        <Button variant="secondary" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Search and filter bar. Gated on extensions.length alone, not also
          !error: a failed manual Refresh must not yank the search/filter
          controls out from under a user who is mid-search on the still-shown
          stale (last-successful) catalog. */}
      {extensions.length > 0 && (
        <div className="mb-6 flex flex-col gap-3 sm:flex-row">
          {/* Search */}
          <div className="relative max-w-md flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
              style={{ color: 'var(--text-3)' }}
            />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search the catalog..."
              className="dui-input w-full rounded-lg py-2 pl-10 pr-3 text-sm outline-none"
            />
          </div>

          {/* Kind filter */}
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="h-4 w-4" style={{ color: 'var(--text-3)' }} />
            <div className="flex flex-wrap gap-1">
              {KIND_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setKind(opt.value)}
                  className="rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
                  style={
                    kind === opt.value
                      ? { background: 'var(--accent)', color: 'var(--accent-ink)' }
                      : { background: 'var(--bg-2)', color: 'var(--text-2)' }
                  }
                >
                  {opt.label} ({kindCounts[opt.value] || 0})
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Error state — the fetch itself failed. Never rendered alongside a
          successful catalog, and never worded as "no extensions exist". */}
      {error && (
        <div
          role="alert"
          className="mb-6 rounded-lg border px-4 py-3 text-sm"
          style={{
            background: 'color-mix(in srgb, var(--err) 15%, transparent)',
            borderColor: 'color-mix(in srgb, var(--err) 35%, transparent)',
            color: 'var(--err)',
          }}
        >
          {error}
        </div>
      )}

      {/* First load only — same skeleton shape as AppsPage. */}
      {loading && (
        <div
          className="grid animate-pulse grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          aria-hidden="true"
        >
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-44 rounded-xl" style={{ background: 'var(--bg-2)' }} />
          ))}
        </div>
      )}

      {/* No results from search/filter — distinct from the error state above:
          this only renders once a catalog actually loaded (extensions.length
          proves that, whether or not a later refresh has since failed). */}
      {!loading && extensions.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon={Package}
          title="No catalog entries match your search"
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch('');
                setKind('all');
              }}
            >
              Clear filters
            </Button>
          }
        />
      )}

      {/* Catalog grid */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(extension => (
            <ExtensionCard key={extension.id} extension={extension} />
          ))}
        </div>
      )}
    </div>
  );
}

export default CatalogPage;

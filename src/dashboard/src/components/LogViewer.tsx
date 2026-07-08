import { useState, useEffect, useMemo, useRef, ReactNode } from 'react';
import { Terminal, Download, Copy, Pause, Play, Hammer, ArrowDown } from 'lucide-react';
import { getAuthHeaders } from '../hooks/useAuth';
import { useToast } from './Toast';

type LogTab = 'runtime' | 'build';
type SourceFilter = 'all' | 'out' | 'err';

interface ParsedLine {
  source: 'out' | 'err' | null;
  text: string;
}

interface BuildLine {
  ts: string | null;
  text: string;
}

// Strip ANSI escape sequences and stray control bytes. The Docker runtime
// returns raw multiplexed log frames whose header bytes can leak into lines.
function sanitize(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  );
}

// The PM2 runtime prefixes combined logs with [out]/[err]; the Docker runtime
// emits no prefixes, so unprefixed lines are treated as stdout.
function parseLine(raw: string): ParsedLine {
  const clean = sanitize(raw);
  if (clean.startsWith('[out] ')) return { source: 'out', text: clean.slice(6) };
  if (clean.startsWith('[err] ')) return { source: 'err', text: clean.slice(6) };
  return { source: null, text: clean };
}

function lineColor(source: 'out' | 'err' | null, text: string): string {
  if (source === 'err' || /\b(error|fatal)\b/i.test(text)) return 'text-red-400';
  if (/\bwarn(ing)?\b/i.test(text)) return 'text-amber-300';
  return 'text-gray-300';
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let idx: number;
  while ((idx = lower.indexOf(q, i)) !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={idx} className="bg-yellow-500/40 text-inherit rounded-sm">
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    i = idx + q.length;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}

const segmentButton = (active: boolean) =>
  `px-2.5 py-1 text-xs font-medium transition-colors ${
    active
      ? 'bg-drop-600 text-white'
      : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600'
  }`;

const toolButton =
  'flex items-center gap-1 px-2 py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded';

function LogViewer({ appName, appStatus }: { appName: string; appStatus?: string }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<LogTab>('runtime');

  // Runtime logs
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [lineCount, setLineCount] = useState(100);
  const [paused, setPaused] = useState(false);
  const [source, setSource] = useState<SourceFilter>('all');
  const [search, setSearch] = useState('');

  // Build log
  const [buildLog, setBuildLog] = useState<string | null>(null);
  const [buildLoading, setBuildLoading] = useState(true);

  // Auto-scroll: stick to the bottom only while the user is already there.
  const containerRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    if (tab !== 'runtime' || paused) return;
    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/v1/logs/${appName}?lines=${lineCount}`, {
          headers: getAuthHeaders(),
        });
        const json = await res.json();
        if (json.success && json.data?.logs) {
          setLogs(json.data.logs);
        }
      } catch {
        // Ignore
      } finally {
        setLogsLoading(false);
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 3000);
    return () => clearInterval(interval);
  }, [appName, lineCount, paused, tab]);

  useEffect(() => {
    if (tab !== 'build') return;
    const fetchBuild = async () => {
      try {
        const res = await fetch(`/api/v1/logs/${appName}/build`, { headers: getAuthHeaders() });
        const json = await res.json();
        setBuildLog(json.success && json.data?.log != null ? json.data.log : null);
      } catch {
        // Ignore
      } finally {
        setBuildLoading(false);
      }
    };

    fetchBuild();
    const interval = setInterval(fetchBuild, 5000);
    return () => clearInterval(interval);
  }, [appName, tab]);

  const parsed = useMemo(() => logs.map(parseLine), [logs]);

  const visible = useMemo(() => {
    const q = search.toLowerCase();
    return parsed.filter(
      (l) =>
        (source === 'all' || (l.source ?? 'out') === source) &&
        (!q || l.text.toLowerCase().includes(q))
    );
  }, [parsed, source, search]);

  const buildLines = useMemo<BuildLine[]>(() => {
    if (!buildLog) return [];
    return buildLog
      .split('\n')
      .filter(Boolean)
      .map((raw) => {
        const m = /^\[([^\]]+)\]\s?(.*)$/.exec(sanitize(raw));
        return m ? { ts: m[1], text: m[2] } : { ts: null, text: sanitize(raw) };
      });
  }, [buildLog]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (pinned && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visible, buildLines, pinned, tab]);

  const jumpToBottom = () => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(visible.map((l) => l.text).join('\n'));
      toast('success', `Copied ${visible.length} lines`);
    } catch {
      toast('error', 'Failed to copy logs');
    }
  };

  const handleDownload = async () => {
    try {
      const res = await fetch(`/api/v1/logs/${appName}?lines=1000`, { headers: getAuthHeaders() });
      const json = await res.json();
      if (json.success && json.data?.logs) {
        const content = json.data.logs.join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${appName}-${new Date().toISOString().split('T')[0]}.log`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch {
      toast('error', 'Failed to download logs');
    }
  };

  const filtered = source !== 'all' || search !== '';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            <h2 className="font-semibold text-gray-900 dark:text-white">Logs</h2>
            {tab === 'runtime' && logsLoading && (
              <span className="text-xs text-gray-400">(loading...)</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
              <button onClick={() => setTab('runtime')} className={segmentButton(tab === 'runtime')}>
                <span className="flex items-center gap-1">
                  <Terminal className="w-3 h-3" />
                  Runtime
                </span>
              </button>
              <button onClick={() => setTab('build')} className={segmentButton(tab === 'build')}>
                <span className="flex items-center gap-1">
                  <Hammer className="w-3 h-3" />
                  Build
                </span>
              </button>
            </div>
            <button onClick={handleDownload} className={toolButton} title="Download raw logs (last 1000 lines)">
              <Download className="w-4 h-4" />
              Download
            </button>
          </div>
        </div>

        {tab === 'runtime' && (
          <div className="flex items-center flex-wrap gap-2 mt-3">
            <div className="flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
              {(['all', 'out', 'err'] as const).map((s) => (
                <button key={s} onClick={() => setSource(s)} className={segmentButton(source === s)}>
                  {s === 'all' ? 'All' : s === 'out' ? 'stdout' : 'stderr'}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search logs..."
              className="flex-1 min-w-[140px] px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white outline-none focus:ring-1 focus:ring-drop-500"
            />
            <select
              value={lineCount}
              onChange={(e) => setLineCount(parseInt(e.target.value, 10))}
              className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white outline-none focus:ring-1 focus:ring-drop-500"
              title="Number of lines to fetch"
            >
              <option value={100}>100 lines</option>
              <option value={500}>500 lines</option>
              <option value={1000}>1000 lines</option>
            </select>
            <button
              onClick={() => setPaused((p) => !p)}
              className={toolButton}
              title={paused ? 'Resume log updates' : 'Pause log updates'}
            >
              {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button onClick={handleCopy} className={toolButton} title="Copy visible lines">
              <Copy className="w-4 h-4" />
              Copy
            </button>
            {filtered && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {visible.length} of {parsed.length} fetched lines
              </span>
            )}
          </div>
        )}
      </div>

      <div className="relative">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="h-96 overflow-auto bg-gray-900 dark:bg-gray-950 p-4 font-mono text-sm"
        >
          {tab === 'runtime' ? (
            parsed.length === 0 ? (
              <p className="text-gray-500">
                {appStatus === 'errored'
                  ? 'No runtime logs. The app may have failed to build — check the Build tab.'
                  : 'No logs available'}
              </p>
            ) : visible.length === 0 ? (
              <p className="text-gray-500">No lines match the current filter</p>
            ) : (
              visible.map((line, i) => (
                <div
                  key={i}
                  className={`whitespace-pre-wrap break-all ${lineColor(line.source, line.text)}`}
                >
                  <Highlight text={line.text} query={search} />
                </div>
              ))
            )
          ) : buildLoading ? (
            <p className="text-gray-500">Loading build log...</p>
          ) : buildLines.length === 0 ? (
            <p className="text-gray-500">No build logs yet</p>
          ) : (
            buildLines.map((line, i) => (
              <div
                key={i}
                className={`whitespace-pre-wrap break-all ${lineColor(null, line.text)}`}
              >
                {line.ts && <span className="text-gray-600">[{line.ts}] </span>}
                {line.text}
              </div>
            ))
          )}
        </div>
        {!pinned && (
          <button
            onClick={jumpToBottom}
            className="absolute bottom-3 right-4 flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-gray-700 text-gray-200 rounded-full shadow hover:bg-gray-600"
          >
            <ArrowDown className="w-3 h-3" />
            Jump to bottom
          </button>
        )}
      </div>
    </div>
  );
}

export default LogViewer;

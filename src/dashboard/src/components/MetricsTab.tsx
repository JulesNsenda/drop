import { useEffect, useRef, useState } from 'react';
import { Activity, Clock, Cpu, Gauge, MemoryStick } from 'lucide-react';
import type { App } from '../hooks/useApi';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import StatCard from './ui/StatCard';

/** Short client-side rolling window (PRD-048 §1.3 — no long-term history in Phase 1). */
const MAX_SAMPLES = 24;

/**
 * Sampling cadence for the rolling history. Matches `useApp`'s poll interval
 * (src/dashboard/src/hooks/useApi.ts) so a new bar appears roughly once per
 * fetch — no separate network polling is introduced here, this just samples
 * whatever `app` (already kept fresh by the parent's poll) holds right now.
 */
const SAMPLE_INTERVAL_MS = 3000;

interface Sample {
  t: number;
  cpu: number;
  memory: number;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Message shown when the app isn't running — never fabricate metrics for a dead process. */
function unavailableReason(status: App['status']): string {
  switch (status) {
    case 'stopped':
      return 'No metrics while stopped.';
    case 'errored':
      return 'App is in an error state — no live metrics.';
    case 'building':
      return 'Building — metrics will appear once the app is running.';
    case 'pending':
      return 'Waiting to deploy — metrics will appear once the app is running.';
    case 'starting':
      return 'Starting — metrics will appear once the app is running.';
    case 'crash-looping':
      return 'Crash-looping — the app is restarting repeatedly, no live metrics.';
    default:
      return 'No live metrics available.';
  }
}

/**
 * Hand-drawn (div-based) bar chart for a short rolling sample window. No
 * external chart library — CSP blocks external scripts, and the PRD-048
 * mockup's bars are simple enough to draw directly.
 */
function SparkBars({
  values,
  max,
  color,
  emptyLabel,
}: {
  values: number[];
  max: number;
  color: string;
  emptyLabel: string;
}) {
  if (values.length === 0) {
    return (
      <div
        className="flex h-16 items-center justify-center text-xs text-faint"
      >
        {emptyLabel}
      </div>
    );
  }

  const safeMax = max > 0 ? max : 1;
  return (
    <div className="flex h-16 items-end gap-[3px]">
      {values.map((v, i) => {
        const pct = Math.min(100, Math.max(2, (v / safeMax) * 100));
        return (
          <div
            key={i}
            className="flex-1 rounded-sm transition-all"
            style={{ height: `${pct}%`, background: color, minWidth: 2 }}
          />
        );
      })}
    </div>
  );
}

/**
 * Metrics tab (PRD-048 Phase 1). Renders live CPU / memory / uptime sourced
 * from the same `GET /apps/:name` payload the rest of the detail page already
 * polls (`useApp`, 3s cadence) — no dedicated metrics poller, no new
 * collector. Requests/sec and p95 latency are Phase 2 (new instrumentation)
 * and are explicitly labeled unavailable rather than faked.
 */
function MetricsTab({ app }: { app: App }) {
  const [history, setHistory] = useState<Sample[]>([]);
  const lastAppName = useRef(app.name);

  const isRunning = app.status === 'running';
  const hasCpu = typeof app.cpu === 'number';
  const hasMemory = typeof app.memory === 'number';
  const hasUptime = typeof app.uptime === 'number';
  const hasLiveMetrics = isRunning && hasCpu && hasMemory;

  // Always-current snapshot for the sampling timer below, so the timer
  // doesn't need to restart (and doesn't need `app` in its dependency array)
  // every time the parent's poll produces a new object.
  const latest = useRef({ hasLiveMetrics, cpu: app.cpu, memory: app.memory });
  latest.current = { hasLiveMetrics, cpu: app.cpu, memory: app.memory };

  // Reset the rolling window when switching to a different app.
  useEffect(() => {
    if (lastAppName.current !== app.name) {
      lastAppName.current = app.name;
      setHistory([]);
    }
  }, [app.name]);

  // Sample the latest live values on a fixed cadence (matching useApp's poll
  // interval) rather than reacting to value changes — an idle app can report
  // the exact same cpu/memory on back-to-back polls, and reacting only to
  // changes would silently skip those (real, just repeated) samples.
  useEffect(() => {
    const takeSample = () => {
      const snap = latest.current;
      if (!snap.hasLiveMetrics) {
        setHistory(prev => (prev.length ? [] : prev));
        return;
      }
      setHistory(prev =>
        [...prev, { t: Date.now(), cpu: snap.cpu as number, memory: snap.memory as number }].slice(
          -MAX_SAMPLES
        )
      );
    };
    takeSample();
    const id = setInterval(takeSample, SAMPLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [app.name]);

  if (!hasLiveMetrics) {
    return (
      <Card padded={false}>
        <EmptyState
          icon={Activity}
          size="sm"
          titleAs="h3"
          title="No metrics available"
          description={unavailableReason(app.status)}
        />
      </Card>
    );
  }

  const cpuValues = history.map(s => s.cpu);
  const memoryValues = history.map(s => s.memory / (1024 * 1024)); // MB for chart scale
  const cpuMax = Math.max(100, ...cpuValues);
  const memoryMax = Math.max(1, ...memoryValues);

  return (
    <div className="space-y-4">
      {/* Current values */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="CPU" value={`${(app.cpu as number).toFixed(1)}%`} icon={Cpu} />
        <StatCard label="Memory" value={formatBytes(app.memory as number)} icon={MemoryStick} />
        <StatCard
          label="Uptime"
          value={hasUptime ? formatUptime(app.uptime as number) : '—'}
          icon={Clock}
        />
      </div>

      {/* Rolling history (client-side, resets on tab/app switch) */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium text-muted">
              CPU history
            </span>
            <span className="text-xs text-faint">
              last {MAX_SAMPLES} samples
            </span>
          </div>
          <SparkBars
            values={cpuValues}
            max={cpuMax}
            color="var(--accent)"
            emptyLabel="Collecting samples…"
          />
        </Card>
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium text-muted">
              Memory history
            </span>
            <span className="text-xs text-faint">
              last {MAX_SAMPLES} samples
            </span>
          </div>
          <SparkBars
            values={memoryValues}
            max={memoryMax}
            color="var(--ok)"
            emptyLabel="Collecting samples…"
          />
        </Card>
      </div>

      {/* Honesty constraint (PRD-048 §2.4): traffic metrics need new
          instrumentation that doesn't exist yet — never fabricate numbers. */}
      <Card>
        <div className="flex items-start gap-3">
          <Gauge className="mt-0.5 h-5 w-5 flex-shrink-0 text-faint" />
          <div>
            <h4 className="text-sm font-medium text-fg">
              Requests/sec &amp; p95 latency — not available yet
            </h4>
            <p className="mt-1 text-sm text-muted">
              Traffic metrics need request-level instrumentation DROP doesn't collect today. This
              lands in a later release (PRD-048 Phase 2) — nothing shown here is a placeholder or
              estimate.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

export default MetricsTab;

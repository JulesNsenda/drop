import { CheckCircle, XCircle, Circle, GitBranch } from 'lucide-react';
import { useDeployTimeline, DeployEpisodeDto, DeployStageName } from '../hooks/useApi';

interface DeployTimelineProps {
  appName: string;
}

const STAGE_LABELS: Record<DeployStageName, string> = {
  triggered: 'Detected',
  'build-started': 'Build started',
  build: 'Build',
  'build-failed': 'Build failed',
  running: 'Running',
  errored: 'Errored',
};

const TRIGGER_LABELS: Record<DeployEpisodeDto['trigger'], string> = {
  deploy: 'Deploy',
  'hot-reload': 'Hot reload',
  upload: 'Upload',
  unknown: 'Unknown trigger',
};

// Mirrors StatusBadge's style/shape but for deploy-episode statuses, which are
// a distinct vocabulary from app statuses — kept local rather than editing
// the shared component. Token-driven via `.dui-badge-*` (styles/app-ui.css).
const EPISODE_STATUS_TONES: Record<string, string> = {
  succeeded: 'dui-badge-ok',
  failed: 'dui-badge-err',
  'in-progress': 'dui-badge-accent',
  superseded: 'dui-badge-neutral',
  interrupted: 'dui-badge-warn',
};

function EpisodeStatusBadge({ status }: { status: string }) {
  const toneClass = EPISODE_STATUS_TONES[status] || 'dui-badge-neutral';
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${toneClass}`}
    >
      {status === 'in-progress' && (
        <span
          className="w-2 h-2 mr-1.5 rounded-full animate-pulse"
          style={{ background: 'var(--accent)' }}
        />
      )}
      {status}
    </span>
  );
}

function formatDuration(ms?: number): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function stageIcon(stage: DeployStageName, ok?: boolean) {
  if (stage === 'build-failed' || stage === 'errored' || ok === false) {
    return <XCircle className="w-4 h-4 shrink-0" style={{ color: 'var(--err)' }} />;
  }
  if (stage === 'running' || (stage === 'build' && ok === true)) {
    return <CheckCircle className="w-4 h-4 shrink-0" style={{ color: 'var(--ok)' }} />;
  }
  return <Circle className="w-4 h-4 shrink-0" style={{ color: 'var(--text-3)' }} />;
}

function LatestEpisode({ episode }: { episode: DeployEpisodeDto }) {
  const totalDuration = formatDuration(episode.durationMs);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <EpisodeStatusBadge status={episode.status} />
          <span className="text-sm" style={{ color: 'var(--text-2)' }}>
            {TRIGGER_LABELS[episode.trigger]}
          </span>
        </div>
        {totalDuration && (
          <span className="text-xs" style={{ color: 'var(--text-3)' }}>
            Total: {totalDuration}
          </span>
        )}
      </div>

      <ol className="space-y-3">
        {episode.stages.map((stage, i) => (
          <li key={`${stage.stage}-${i}`} className="flex items-start gap-3">
            {stageIcon(stage.stage, stage.ok)}
            <div className="flex-1 flex items-center justify-between">
              <span className="text-sm" style={{ color: 'var(--text)' }}>
                {STAGE_LABELS[stage.stage]}
              </span>
              <div
                className="flex items-center gap-2 text-xs whitespace-nowrap ml-4"
                style={{ color: 'var(--text-3)' }}
              >
                {stage.durationMs != null && <span>{formatDuration(stage.durationMs)}</span>}
                <span>{new Date(stage.at).toLocaleTimeString()}</span>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function DeployTimeline({ appName }: DeployTimelineProps) {
  const { episodes, loading, error } = useDeployTimeline(appName);

  return (
    <div className="dui-card rounded-xl mb-6">
      <div
        className="flex items-center px-4 py-3 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        <GitBranch className="w-4 h-4 mr-2" style={{ color: 'var(--text-2)' }} />
        <h2 className="font-semibold" style={{ color: 'var(--text)' }}>
          Deploy Timeline
        </h2>
      </div>
      <div className="p-4">
        {/* An error REPLACES the timeline only when there is nothing to show.
            This polls every 5s, so gating the whole card on `error` meant one
            transient failure tore down a rendered timeline and the next poll
            rebuilt it — same defect AppDetailPage carries above this card.
            With data on screen the error is a banner instead (below). */}
        {error && episodes.length > 0 && (
          <div
            role="alert"
            className="mb-4 p-3 border rounded-lg text-sm"
            style={{
              background: 'color-mix(in srgb, var(--err) 15%, transparent)',
              borderColor: 'color-mix(in srgb, var(--err) 35%, transparent)',
              color: 'var(--err)',
            }}
          >
            {error}
          </div>
        )}
        {loading && episodes.length === 0 ? (
          <div className="animate-pulse space-y-2">
            <div className="h-4 w-64 rounded" style={{ background: 'var(--border-2)' }} />
            <div className="h-4 w-48 rounded" style={{ background: 'var(--border-2)' }} />
          </div>
        ) : error && episodes.length === 0 ? (
          <div
            className="p-3 border rounded-lg text-sm"
            style={{
              background: 'color-mix(in srgb, var(--err) 15%, transparent)',
              borderColor: 'color-mix(in srgb, var(--err) 35%, transparent)',
              color: 'var(--err)',
            }}
          >
            {error}
          </div>
        ) : episodes.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>
            No deploys recorded yet
          </p>
        ) : (
          <>
            <LatestEpisode episode={episodes[0]} />

            {episodes.length > 1 && (
              <div className="mt-6 pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
                <h3
                  className="text-xs font-medium uppercase tracking-wide mb-2"
                  style={{ color: 'var(--text-3)' }}
                >
                  Recent deploys
                </h3>
                <div className="space-y-2 max-h-60 overflow-auto">
                  {episodes.slice(1).map(ep => (
                    <div
                      key={ep.deployId}
                      className="flex items-center justify-between py-1.5 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs" style={{ color: 'var(--text-3)' }}>
                          {ep.deployId.slice(0, 8)}
                        </span>
                        <span style={{ color: 'var(--text-2)' }}>{TRIGGER_LABELS[ep.trigger]}</span>
                        <EpisodeStatusBadge status={ep.status} />
                      </div>
                      <div
                        className="flex items-center gap-3 text-xs whitespace-nowrap ml-4"
                        style={{ color: 'var(--text-3)' }}
                      >
                        {formatDuration(ep.durationMs) && (
                          <span>{formatDuration(ep.durationMs)}</span>
                        )}
                        <span>{relativeTime(ep.startedAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default DeployTimeline;

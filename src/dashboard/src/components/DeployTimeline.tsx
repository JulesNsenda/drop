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
  unknown: 'Unknown trigger',
};

// Mirrors StatusBadge's style/shape but for deploy-episode statuses, which are
// a distinct vocabulary from app statuses — kept local rather than editing
// the shared component.
const EPISODE_STATUS_STYLES: Record<string, string> = {
  succeeded: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  'in-progress': 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  superseded: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  interrupted: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
};

function EpisodeStatusBadge({ status }: { status: string }) {
  const colorClass = EPISODE_STATUS_STYLES[status] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colorClass}`}>
      {status === 'in-progress' && (
        <span className="w-2 h-2 mr-1.5 bg-blue-500 rounded-full animate-pulse" />
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
    return <XCircle className="w-4 h-4 text-red-500 shrink-0" />;
  }
  if (stage === 'running' || (stage === 'build' && ok === true)) {
    return <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />;
  }
  return <Circle className="w-4 h-4 text-gray-400 shrink-0" />;
}

function LatestEpisode({ episode }: { episode: DeployEpisodeDto }) {
  const totalDuration = formatDuration(episode.durationMs);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <EpisodeStatusBadge status={episode.status} />
          <span className="text-sm text-gray-500 dark:text-gray-400">{TRIGGER_LABELS[episode.trigger]}</span>
        </div>
        {totalDuration && (
          <span className="text-xs text-gray-500 dark:text-gray-400">Total: {totalDuration}</span>
        )}
      </div>

      <ol className="space-y-3">
        {episode.stages.map((stage, i) => (
          <li key={`${stage.stage}-${i}`} className="flex items-start gap-3">
            {stageIcon(stage.stage, stage.ok)}
            <div className="flex-1 flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-300">{STAGE_LABELS[stage.stage]}</span>
              <div className="flex items-center gap-2 text-xs text-gray-400 whitespace-nowrap ml-4">
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
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
      <div className="flex items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <GitBranch className="w-4 h-4 text-gray-500 dark:text-gray-400 mr-2" />
        <h2 className="font-semibold text-gray-900 dark:text-white">Deploy Timeline</h2>
      </div>
      <div className="p-4">
        {loading && episodes.length === 0 ? (
          <div className="animate-pulse space-y-2">
            <div className="h-4 w-64 bg-gray-200 dark:bg-gray-700 rounded" />
            <div className="h-4 w-48 bg-gray-200 dark:bg-gray-700 rounded" />
          </div>
        ) : error ? (
          <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        ) : episodes.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No deploys recorded yet</p>
        ) : (
          <>
            <LatestEpisode episode={episodes[0]} />

            {episodes.length > 1 && (
              <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
                  Recent deploys
                </h3>
                <div className="space-y-2 max-h-60 overflow-auto">
                  {episodes.slice(1).map((ep) => (
                    <div key={ep.deployId} className="flex items-center justify-between py-1.5 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-gray-400">{ep.deployId.slice(0, 8)}</span>
                        <span className="text-gray-500 dark:text-gray-400">{TRIGGER_LABELS[ep.trigger]}</span>
                        <EpisodeStatusBadge status={ep.status} />
                      </div>
                      <div className="flex items-center gap-3 text-xs text-gray-400 whitespace-nowrap ml-4">
                        {formatDuration(ep.durationMs) && <span>{formatDuration(ep.durationMs)}</span>}
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

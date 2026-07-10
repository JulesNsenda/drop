interface StatusBadgeProps {
  status: string;
}

// Token-driven tones (see styles/app-ui.css `.dui-badge-*`) — mirrors the
// semantic hues of the previous Tailwind palette: pending stays a distinct
// "waiting" tone from the "actively working" building/starting tone.
const statusTones: Record<string, string> = {
  running: 'dui-badge-ok',
  stopped: 'dui-badge-neutral',
  pending: 'dui-badge-warn',
  building: 'dui-badge-accent',
  starting: 'dui-badge-accent',
  errored: 'dui-badge-err',
};

function StatusBadge({ status }: StatusBadgeProps) {
  const toneClass = statusTones[status] || 'dui-badge-neutral';

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${toneClass}`}
    >
      {status === 'running' && (
        <span
          className="w-2 h-2 mr-1.5 rounded-full animate-pulse"
          style={{ background: 'var(--ok)' }}
        />
      )}
      {status}
    </span>
  );
}

export default StatusBadge;

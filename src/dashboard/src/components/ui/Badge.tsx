import { HTMLAttributes } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Render a small leading dot in the badge's tone color (e.g. a live-status indicator). */
  dot?: boolean;
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'dui-badge-neutral',
  accent: 'dui-badge-accent',
  ok: 'dui-badge-ok',
  warn: 'dui-badge-warn',
  err: 'dui-badge-err',
};

/**
 * Generic status/role badge primitive (PRD-045). Token-driven via `.drop-ui`
 * (see styles/app-ui.css `.dui-badge-*`) — render inside a `.drop-ui` scope.
 *
 * This wraps the same semantic tones `StatusBadge` (components/StatusBadge.tsx)
 * uses for app run-states — see `statusToTone` below — without rewriting that
 * component. `StatusBadge` keeps its own existing color mapping; pages may
 * adopt this primitive directly in a later PRD.
 */
function Badge({ tone = 'neutral', dot = false, className = '', children, ...rest }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]} ${className}`}
      {...rest}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} aria-hidden="true" />}
      {children}
    </span>
  );
}

export default Badge;

/**
 * Maps a `StatusBadge`-style app run-status string to a Badge tone, so
 * callers can render the same semantic color via the token-driven primitive
 * without duplicating StatusBadge's color table.
 */
export function statusToTone(status: string): BadgeTone {
  switch (status) {
    case 'running':
      return 'ok';
    case 'errored':
      return 'err';
    case 'pending':
    case 'building':
    case 'starting':
    case 'crash-looping':
      return 'warn';
    default:
      return 'neutral';
  }
}

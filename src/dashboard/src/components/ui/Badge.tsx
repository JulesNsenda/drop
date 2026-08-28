import { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

/**
 * Generic status/role badge primitive (PRD-045, CVA-ised in DROP-156).
 *
 * Token-driven via `.drop-ui` (see styles/app-ui.css `.dui-badge-*`) — render
 * inside a `.drop-ui` scope.
 *
 * This wraps the same semantic tones `StatusBadge` (components/StatusBadge.tsx)
 * uses for app run-states — see `statusToTone` below — without rewriting that
 * component. `StatusBadge` keeps its own existing color mapping.
 */
const badge = cva('inline-flex items-center gap-1.5 rounded-full font-medium', {
  variants: {
    tone: {
      neutral: 'dui-badge-neutral',
      accent: 'dui-badge-accent',
      ok: 'dui-badge-ok',
      warn: 'dui-badge-warn',
      err: 'dui-badge-err',
    },
    size: {
      sm: 'px-2 py-0.5 text-[11px]',
      md: 'px-2.5 py-0.5 text-xs',
    },
  },
  defaultVariants: { tone: 'neutral', size: 'md' },
});

export type BadgeTone = NonNullable<VariantProps<typeof badge>['tone']>;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {
  /** Render a small leading dot in the badge's tone color (e.g. a live-status indicator). */
  dot?: boolean;
}

function Badge({ tone, size, dot = false, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cn(badge({ tone, size }), className)} {...rest}>
      {dot && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: 'currentColor' }}
          aria-hidden="true"
        />
      )}
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
    case 'needs-config':
      return 'warn';
    default:
      return 'neutral';
  }
}

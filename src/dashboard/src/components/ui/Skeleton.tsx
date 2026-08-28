import { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/**
 * A single loading placeholder bar (DROP-156 PR 2d).
 *
 * `aria-hidden` always: a placeholder is decoration, and its dimensions carry
 * no meaning to a screen reader. Announcing the loading STATE is
 * `SkeletonText`'s job — see below.
 */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('h-4 rounded bg-line-2', className)}
      {...rest}
    />
  );
}

export interface SkeletonTextProps extends HTMLAttributes<HTMLDivElement> {
  /** Number of placeholder bars. */
  lines?: number;
  /**
   * Width utility per bar, cycled. The tree's existing skeletons used
   * staggered widths rather than uniform blocks, which reads as text.
   */
  widths?: string[];
  /**
   * What is loading, e.g. "Loading API keys". REQUIRED, because the point of
   * this component over a bare div is that the wait is announced.
   */
  label: string;
}

const DEFAULT_WIDTHS = ['w-48', 'w-36'];

/**
 * A pulsing block of placeholder bars, standing in for text that is loading.
 *
 * WHY THIS EXISTS BEYOND DE-DUPLICATION. The same five-line block was repeated
 * across ApiKeysTab, GitWebhooksTab, SettingsPage, DatabaseTab and
 * DeployTimeline — and the fill colour had already drifted, most using
 * `var(--border-2)` and SettingsPage using `var(--bg-2)`. One implementation
 * settles that.
 *
 * More importantly it fixes what a screen reader got: nothing. The old blocks
 * were undecorated `<div>`s, so a non-sighted user was given no signal that
 * content was on its way — the region was simply empty until it wasn't. Here
 * the container is a polite live region carrying the label, and the bars
 * themselves are `aria-hidden` so their shapes are never announced.
 *
 * `AppsPage` already had `aria-hidden="true"` on its own skeleton, which is
 * half of this — it silenced the noise but supplied no replacement signal.
 */
export function SkeletonText({
  lines = 2,
  widths = DEFAULT_WIDTHS,
  label,
  className,
  ...rest
}: SkeletonTextProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn('animate-pulse space-y-2', className)}
      {...rest}
    >
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={widths[i % widths.length]} />
      ))}
    </div>
  );
}

export default Skeleton;

import { ReactNode, ElementType } from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Retry button, "clear filters" link, etc. */
  action?: ReactNode;
  /** Icon colour. `error` is `--err`; `neutral` is the quiet `--text-3`. */
  tone?: 'neutral' | 'error';
  /**
   * Icon size. Deliberately INDEPENDENT of tone: the tree has all three
   * combinations — a large neutral icon for "nothing matched your filter"
   * (AppsPage, CatalogPage), a small neutral one for a panel that has nothing
   * to show yet (MetricsTab, DatabaseTab), and a small error one for a panel
   * that failed to load (DatabaseTab). Coupling the two would have forced two
   * of those to lie.
   */
  size?: 'sm' | 'lg';
  /**
   * Element for the title. Defaults to `p` — deliberately NOT a heading,
   * because these blocks appear at varying depths and silently injecting an
   * `h3` would reorder the document outline of whatever page adopts it. Call
   * sites that already rendered a heading pass `titleAs="h3"` and keep it.
   */
  titleAs?: ElementType;
  className?: string;
}

/**
 * The "nothing to show" block (DROP-156 PR 2d).
 *
 * Five sites hand-wrote this — DatabaseTab twice, MetricsTab, AppsPage and
 * CatalogPage — each repeating `py-12 text-center`, a centred icon with the
 * token hand-piped through `style`, and a muted line of copy.
 */
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = 'neutral',
  size = 'lg',
  titleAs: Title = 'p',
  className,
}: EmptyStateProps) {
  // Giving it a heading element means it should look like one. Keeps the two
  // shapes the tree already had without a separate styling prop.
  const isHeading = Title !== 'p';
  return (
    <div className={cn('py-12 text-center', className)}>
      {Icon && (
        <Icon
          aria-hidden="true"
          className={cn(
            'mx-auto',
            size === 'sm' ? 'mb-3 h-8 w-8' : 'mb-4 h-12 w-12',
            tone === 'error' ? 'text-err' : 'text-faint'
          )}
        />
      )}
      <Title className={cn('text-fg', isHeading && 'mb-1 text-base font-semibold')}>
        {title}
      </Title>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export default EmptyState;

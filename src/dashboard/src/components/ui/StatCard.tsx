import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  /** Optional delta text, e.g. "+3 today" or "-1 this week". Sign of `deltaDirection` colors it. */
  delta?: string;
  deltaDirection?: 'up' | 'down' | 'neutral';
  icon?: LucideIcon;
  className?: string;
}

/**
 * Overview-strip stat tile primitive (PRD-045), for the dashboard summary
 * row: label, value, optional delta. Render inside a `.drop-ui` scope.
 */
function StatCard({ label, value, delta, deltaDirection = 'neutral', icon: Icon, className = '' }: StatCardProps) {
  const deltaClass =
    deltaDirection === 'up' ? 'dui-stat-delta-up' : deltaDirection === 'down' ? 'dui-stat-delta-down' : '';

  return (
    <div className={`dui-stat-card dui-card rounded-xl p-5 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-muted">
          {label}
        </span>
        {Icon && <Icon className="h-4 w-4 flex-shrink-0 text-faint" aria-hidden="true" />}
      </div>
      <div className="mt-2 text-2xl font-semibold text-fg font-mono">
        {value}
      </div>
      {delta && (
        <div className={`mt-1 text-xs font-medium ${deltaClass}`} style={!deltaClass ? { color: 'var(--text-3)' } : undefined}>
          {delta}
        </div>
      )}
    </div>
  );
}

export default StatCard;

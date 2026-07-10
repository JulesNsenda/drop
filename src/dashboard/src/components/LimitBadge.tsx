import { useUsage } from '../hooks/useApi';

/**
 * App-limit indicator (PRD-027). Shows used/limit; turns amber at >=80% and
 * red when at the limit. Renders nothing for unlimited (admins / single-user).
 */
function LimitBadge() {
  const { usage } = useUsage();

  if (!usage || usage.limit <= 0) return null;

  const { used, limit } = usage;
  const ratio = used / limit;
  const atLimit = used >= limit;
  const warning = ratio >= 0.8;

  const toneClass = atLimit ? 'dui-badge-err' : warning ? 'dui-badge-warn' : 'dui-badge-neutral';

  return (
    <div
      className={`px-3 py-1.5 rounded-lg text-xs font-medium ${toneClass}`}
      title={atLimit ? 'You have reached your app limit' : `${used} of ${limit} apps used`}
    >
      Apps: {used}/{limit}
      {warning && !atLimit && <span className="ml-1">— nearing limit</span>}
      {atLimit && <span className="ml-1">— limit reached</span>}
    </div>
  );
}

export default LimitBadge;

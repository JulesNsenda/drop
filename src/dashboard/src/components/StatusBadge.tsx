interface StatusBadgeProps {
  status: string;
}

const statusColors: Record<string, string> = {
  running: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  stopped: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  building: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  starting: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  errored: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
};

function StatusBadge({ status }: StatusBadgeProps) {
  const colorClass = statusColors[status] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colorClass}`}
    >
      {status === 'running' && (
        <span className="w-2 h-2 mr-1.5 bg-green-500 rounded-full animate-pulse" />
      )}
      {status}
    </span>
  );
}

export default StatusBadge;

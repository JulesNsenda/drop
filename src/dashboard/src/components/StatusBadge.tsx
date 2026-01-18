interface StatusBadgeProps {
  status: string;
}

const statusColors: Record<string, string> = {
  running: 'bg-green-100 text-green-800',
  stopped: 'bg-gray-100 text-gray-800',
  pending: 'bg-yellow-100 text-yellow-800',
  building: 'bg-blue-100 text-blue-800',
  starting: 'bg-blue-100 text-blue-800',
  errored: 'bg-red-100 text-red-800',
};

function StatusBadge({ status }: StatusBadgeProps) {
  const colorClass = statusColors[status] || 'bg-gray-100 text-gray-800';

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

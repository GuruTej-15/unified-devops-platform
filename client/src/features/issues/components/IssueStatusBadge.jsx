import { STATUS_COLORS, PRIORITY_COLORS, TYPE_COLORS, cn } from '../../../lib/utils.js';

export function StatusBadge({ status, className = '' }) {
  const theme = STATUS_COLORS[status] || STATUS_COLORS.open;
  const label = status ? status.replace('_', ' ') : 'Open';

  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold uppercase tracking-wider border capitalize',
        theme.bg,
        theme.text,
        theme.border,
        className
      )}
    >
      {label}
    </span>
  );
}

export function PriorityBadge({ priority, className = '' }) {
  const theme = PRIORITY_COLORS[priority] || PRIORITY_COLORS.medium;
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs capitalize',
        theme.bg,
        theme.text,
        className
      )}
    >
      {priority}
    </span>
  );
}

export function TypeBadge({ type, className = '' }) {
  const theme = TYPE_COLORS[type] || TYPE_COLORS.task;
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs capitalize font-medium',
        theme.bg,
        theme.text,
        className
      )}
    >
      {type}
    </span>
  );
}

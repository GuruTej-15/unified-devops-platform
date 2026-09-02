import { cn } from '../../lib/utils.js';

export default function Avatar({ user, name, src, size = 'md', className = '' }) {
  const displayName =
    name ||
    (user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '') ||
    user?.username ||
    '?';
  const initials = displayName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();

  const sizes = {
    sm: 'w-6 h-6 text-xs',
    md: 'w-8 h-8 text-sm',
    lg: 'w-10 h-10 text-base',
    xl: 'w-12 h-12 text-lg',
  };

  const imageSrc = src || user?.avatar;

  if (imageSrc) {
    return (
      <img
        src={imageSrc}
        alt={displayName}
        className={cn('rounded-full object-cover border border-gray-200', sizes[size], className)}
      />
    );
  }

  // Consistent background color based on name hash
  const colors = [
    'bg-blue-600',
    'bg-indigo-600',
    'bg-purple-600',
    'bg-rose-600',
    'bg-amber-600',
    'bg-emerald-600',
    'bg-teal-600',
  ];
  const charCode = displayName.charCodeAt(0) || 0;
  const bgColor = colors[charCode % colors.length];

  return (
    <div
      className={cn(
        'rounded-full flex items-center justify-center font-medium text-white shadow-xs select-none',
        bgColor,
        sizes[size],
        className
      )}
      title={displayName}
    >
      {initials}
    </div>
  );
}

import { cn } from '../../lib/utils.js';

export default function LoadingSpinner({ size = 'md', className = '', label }) {
  const sizes = {
    sm: 'h-4 w-4 border-2',
    md: 'h-8 w-8 border-3',
    lg: 'h-12 w-12 border-4',
  };

  return (
    <div className={cn('flex flex-col items-center justify-center p-6 space-y-3', className)}>
      <div
        className={cn(
          'animate-spin rounded-full border-primary-200 border-t-primary-600',
          sizes[size]
        )}
      />
      {label && <p className="text-sm font-medium text-gray-500">{label}</p>}
    </div>
  );
}

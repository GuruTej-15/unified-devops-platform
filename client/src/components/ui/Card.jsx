import { cn } from '../../lib/utils.js';

export default function Card({ children, className = '', title, subtitle, action, ...props }) {
  return (
    <div
      className={cn(
        'bg-white rounded-xl border border-gray-200/80 shadow-xs overflow-hidden transition-all',
        className
      )}
      {...props}
    >
      {(title || action) && (
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            {title && <h3 className="text-base font-semibold text-gray-900">{title}</h3>}
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          {action && <div>{action}</div>}
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  );
}

import { formatTimeAgo } from '../../../lib/utils.js';

export default function BranchList({ branches = [] }) {
  if (branches.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 text-sm">
        No branches retrieved or live branch query is pending.
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-100 bg-white rounded-xl border border-gray-200/80 overflow-hidden">
      {branches.map((branch) => (
        <div
          key={branch.name}
          className="p-4 flex items-center justify-between hover:bg-gray-50/50 transition-colors"
        >
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-mono text-sm font-bold text-gray-900">{branch.name}</span>
            </div>
            {branch.lastCommit && (
              <p className="text-xs text-gray-500 mt-1 truncate max-w-lg">
                <span className="font-mono text-gray-600 bg-gray-100 px-1 py-0.5 rounded mr-1.5">
                  {branch.lastCommit.sha?.substring(0, 7)}
                </span>
                {branch.lastCommit.message}
              </p>
            )}
          </div>

          <div className="text-right text-xs text-gray-500">
            {branch.lastCommit?.date && <p>Updated {formatTimeAgo(branch.lastCommit.date)}</p>}
            {branch.lastCommit?.author && (
              <p className="text-gray-400 mt-0.5">by {branch.lastCommit.author}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

import { Link } from 'react-router';
import { StatusBadge, PriorityBadge, TypeBadge } from './IssueStatusBadge.jsx';
import Avatar from '../../../components/ui/Avatar.jsx';
import { formatTimeAgo } from '../../../lib/utils.js';

export default function IssueCard({ issue, projectId }) {
  return (
    <Link
      to={`/projects/${projectId}/issues/${issue.issueKey}`}
      className="block bg-white rounded-xl border border-gray-200/80 p-4 shadow-2xs hover:shadow-md hover:border-primary-300 transition-all group"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center space-x-2">
          <span className="font-mono text-xs font-bold text-primary-600 group-hover:underline">
            {issue.issueKey}
          </span>
          <TypeBadge type={issue.type} />
        </div>
        <StatusBadge status={issue.status} />
      </div>

      <h4 className="mt-2 text-sm font-semibold text-gray-900 group-hover:text-primary-600 transition-colors line-clamp-2">
        {issue.title}
      </h4>

      {issue.description && (
        <p className="mt-1 text-xs text-gray-500 line-clamp-1">{issue.description}</p>
      )}

      <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center space-x-2">
          <PriorityBadge priority={issue.priority} />
          {issue.labels?.length > 0 && (
            <span className="text-[11px] text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-100">
              +{issue.labels.length} {issue.labels.length === 1 ? 'label' : 'labels'}
            </span>
          )}
        </div>

        <div className="flex items-center space-x-2">
          <span className="text-[11px] text-gray-400">{formatTimeAgo(issue.createdAt)}</span>
          <Avatar user={issue.assignee} size="sm" />
        </div>
      </div>
    </Link>
  );
}

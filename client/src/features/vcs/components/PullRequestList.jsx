import { Link, useParams } from 'react-router';
import Avatar from '../../../components/ui/Avatar.jsx';
import Badge from '../../../components/ui/Badge.jsx';
import { formatTimeAgo } from '../../../lib/utils.js';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';

export default function PullRequestList({ pullRequests = [] }) {
  const { projectId } = useParams();

  if (pullRequests.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 text-sm">
        No pull requests synced yet. Trigger a repository sync to pull pull requests.
      </div>
    );
  }

  const getStateBadge = (state) => {
    switch (state) {
      case 'merged':
        return (
          <Badge variant="primary" size="sm">
            MERGED
          </Badge>
        );
      case 'closed':
        return (
          <Badge variant="default" size="sm">
            CLOSED
          </Badge>
        );
      default:
        return (
          <Badge variant="success" size="sm">
            OPEN
          </Badge>
        );
    }
  };

  return (
    <div className="divide-y divide-gray-100 bg-white rounded-xl border border-gray-200/80 overflow-hidden">
      {pullRequests.map((pr) => (
        <div
          key={pr.number}
          className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:bg-gray-50/50 transition-colors"
        >
          <div className="flex items-start space-x-3 min-w-0">
            <Avatar name={pr.authorLogin} src={pr.authorAvatar} size="sm" className="mt-0.5" />
            <div className="min-w-0">
              <div className="flex items-center space-x-2">
                <span className="font-semibold text-gray-400 text-sm">#{pr.number}</span>
                <p className="text-sm font-semibold text-gray-900 truncate">{pr.title}</p>
                {getStateBadge(pr.state)}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 mt-1">
                <span>by {pr.authorLogin}</span>
                <span>•</span>
                <span>{formatTimeAgo(pr.updatedAt || pr.createdAt)}</span>
                <span>•</span>
                <span className="font-mono text-gray-600 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-100">
                  {pr.sourceBranch} → {pr.targetBranch}
                </span>

                {pr.matchedIssueKeys?.length > 0 && (
                  <>
                    <span>•</span>
                    <div className="flex items-center space-x-1">
                      {pr.matchedIssueKeys.map((key) => (
                        <Link
                          key={key}
                          to={`/projects/${projectId}/issues/${key}`}
                          className="font-mono text-[11px] font-bold text-primary-600 bg-primary-50 px-1.5 py-0.5 rounded border border-primary-100 hover:underline"
                        >
                          {key}
                        </Link>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2 self-end sm:self-center">
            {pr.url && (
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="text-gray-400 hover:text-gray-600 p-1"
                title="View on GitHub"
              >
                <ArrowTopRightOnSquareIcon className="w-4 h-4" />
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

import { Link, useParams } from 'react-router';
import Avatar from '../../../components/ui/Avatar.jsx';
import { formatTimeAgo } from '../../../lib/utils.js';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';

export default function CommitList({ commits = [] }) {
  const { projectId } = useParams();

  if (commits.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 text-sm">
        No commits synced yet. Trigger a repository sync to pull the latest commits.
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-100 bg-white rounded-xl border border-gray-200/80 overflow-hidden">
      {commits.map((commit) => (
        <div
          key={commit.sha}
          className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:bg-gray-50/50 transition-colors"
        >
          <div className="flex items-start space-x-3 min-w-0">
            <Avatar
              name={commit.authorName}
              src={commit.authorAvatar}
              size="sm"
              className="mt-0.5"
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">{commit.message}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 mt-0.5">
                <span className="font-medium text-gray-700">{commit.authorName}</span>
                <span>•</span>
                <span>{formatTimeAgo(commit.authoredAt)}</span>
                {commit.matchedIssueKeys?.length > 0 && (
                  <>
                    <span>•</span>
                    <div className="flex items-center space-x-1">
                      {commit.matchedIssueKeys.map((key) => (
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

          <div className="flex items-center space-x-3 self-end sm:self-center">
            <span className="font-mono text-xs font-semibold text-gray-500 bg-gray-100 px-2 py-1 rounded">
              {commit.sha?.substring(0, 7)}
            </span>
            {commit.url && (
              <a
                href={commit.url}
                target="_blank"
                rel="noreferrer"
                className="text-gray-400 hover:text-gray-600"
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

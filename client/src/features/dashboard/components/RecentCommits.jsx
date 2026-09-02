import { Link, useParams } from 'react-router';
import { formatTimeAgo } from '../../../lib/utils.js';

export default function RecentCommits({ commits = [] }) {
  const { projectId } = useParams();

  if (commits.length === 0) {
    return (
      <div className="text-center py-6 text-xs text-gray-400">No recent commits synced yet.</div>
    );
  }

  return (
    <div className="space-y-3">
      {commits.map((commit) => (
        <div
          key={commit.sha}
          className="flex items-center justify-between p-2.5 rounded-lg bg-gray-50/70 border border-gray-100 text-xs"
        >
          <div className="min-w-0 flex-1 mr-3">
            <p className="font-semibold text-gray-900 truncate">{commit.message}</p>
            <div className="flex items-center space-x-2 text-[11px] text-gray-400 mt-0.5">
              <span>{commit.authorName}</span>
              <span>•</span>
              <span>{formatTimeAgo(commit.authoredAt)}</span>
              {commit.matchedIssueKeys?.map((key) => (
                <Link
                  key={key}
                  to={`/projects/${projectId}/issues/${key}`}
                  className="font-mono text-primary-600 font-bold bg-primary-50 px-1 py-0.2 rounded hover:underline"
                >
                  {key}
                </Link>
              ))}
            </div>
          </div>
          <span className="font-mono text-[11px] font-bold text-gray-500 bg-white px-2 py-0.5 rounded border border-gray-200 flex-shrink-0">
            {commit.sha?.substring(0, 7)}
          </span>
        </div>
      ))}
    </div>
  );
}

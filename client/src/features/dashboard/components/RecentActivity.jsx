import { formatTimeAgo } from '../../../lib/utils.js';

export default function RecentActivity({ activities = [] }) {
  if (activities.length === 0) {
    return (
      <div className="text-center py-6 text-xs text-gray-400">
        No recent project activity recorded yet.
      </div>
    );
  }

  const getActionDescription = (act) => {
    const action = act.action;
    const actorName = act.actor
      ? `${act.actor.firstName || ''} ${act.actor.lastName || ''}`.trim()
      : 'System';

    if (action === 'issue.created')
      return `${actorName} created issue ${act.metadata?.issueKey || ''}`;
    if (action === 'issue.status.changed')
      return `${actorName} changed issue status to ${act.metadata?.newStatus || ''}`;
    if (action === 'issue.commented')
      return `${actorName} commented on ${act.metadata?.issueKey || ''}`;
    if (action === 'repository.connected') return `${actorName} connected a VCS repository`;
    if (action === 'repository.synced') return `VCS repository synchronized`;
    if (action === 'project.created') return `${actorName} created this project`;
    if (action === 'project.member.added') return `${actorName} added a new member`;
    return `${actorName} performed ${action}`;
  };

  return (
    <div className="flow-root">
      <ul className="divide-y divide-gray-50">
        {activities.map((act) => (
          <li key={act._id} className="py-2.5 flex items-center justify-between text-xs">
            <div className="flex items-center space-x-2 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-primary-500 flex-shrink-0" />
              <span className="text-gray-800 font-medium truncate">
                {getActionDescription(act)}
              </span>
            </div>
            <span className="text-gray-400 text-[11px] flex-shrink-0 ml-2">
              {formatTimeAgo(act.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

import {
  DocumentCheckIcon,
  CheckCircleIcon,
  CodeBracketSquareIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';

export default function StatsOverview({ dashboard = {} }) {
  const { issueStats = [], memberCount = 0, repositoryCount = 0 } = dashboard;

  const totalIssues = issueStats.reduce((acc, curr) => acc + curr.count, 0);
  const doneIssues = issueStats
    .filter((s) => s._id === 'done' || s._id === 'closed')
    .reduce((acc, curr) => acc + curr.count, 0);
  const inProgressIssues = issueStats
    .filter((s) => s._id === 'in_progress' || s._id === 'in_review')
    .reduce((acc, curr) => acc + curr.count, 0);

  const stats = [
    {
      name: 'Total Issues',
      value: totalIssues,
      icon: DocumentCheckIcon,
      color: 'bg-blue-50 text-blue-600',
      description: `${inProgressIssues} active in progress`,
    },
    {
      name: 'Resolved / Done',
      value: doneIssues,
      icon: CheckCircleIcon,
      color: 'bg-emerald-50 text-emerald-600',
      description: totalIssues
        ? `${Math.round((doneIssues / totalIssues) * 100)}% delivery completion`
        : '0% completion',
    },
    {
      name: 'Connected Repos',
      value: repositoryCount,
      icon: CodeBracketSquareIcon,
      color: 'bg-purple-50 text-purple-600',
      description: 'GitHub VCS sources',
    },
    {
      name: 'Team Members',
      value: memberCount,
      icon: UserGroupIcon,
      color: 'bg-amber-50 text-amber-600',
      description: 'Active contributors',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((item) => {
        const Icon = item.icon;
        return (
          <div
            key={item.name}
            className="bg-white rounded-xl border border-gray-200/80 p-5 shadow-2xs hover:shadow-xs transition-shadow flex items-center justify-between"
          >
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                {item.name}
              </p>
              <p className="text-2xl font-extrabold text-gray-900 mt-1">{item.value}</p>
              <p className="text-[11px] text-gray-400 mt-0.5">{item.description}</p>
            </div>
            <div className={`p-3 rounded-xl ${item.color}`}>
              <Icon className="w-6 h-6" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

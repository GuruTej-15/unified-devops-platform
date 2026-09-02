import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';

export default function IssuesByStatus({ issueStats = [] }) {
  const statusLabels = {
    open: 'Open',
    in_progress: 'In Progress',
    in_review: 'In Review',
    done: 'Done',
    closed: 'Closed',
  };

  const statusColors = {
    open: '#3b82f6',
    in_progress: '#f59e0b',
    in_review: '#a855f7',
    done: '#10b981',
    closed: '#6b7280',
  };

  const data = ['open', 'in_progress', 'in_review', 'done', 'closed'].map((status) => {
    const found = issueStats.find((s) => s._id === status);
    return {
      name: statusLabels[status] || status,
      key: status,
      count: found ? found.count : 0,
    };
  });

  const total = data.reduce((acc, curr) => acc + curr.count, 0);

  if (total === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-xs text-gray-400">
        No issues created yet to display status breakdown.
      </div>
    );
  }

  return (
    <div className="h-56 w-full pt-2">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#6b7280' }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e293b',
              borderRadius: '8px',
              border: 'none',
              color: '#fff',
              fontSize: '12px',
            }}
          />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {data.map((entry) => (
              <Cell key={entry.key} fill={statusColors[entry.key] || '#3b82f6'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

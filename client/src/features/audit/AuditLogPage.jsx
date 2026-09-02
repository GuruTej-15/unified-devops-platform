import { useState, useEffect } from 'react';
import api from '../../lib/axios.js';
import Card from '../../components/ui/Card.jsx';
import Avatar from '../../components/ui/Avatar.jsx';
import Badge from '../../components/ui/Badge.jsx';
import LoadingSpinner from '../../components/ui/LoadingSpinner.jsx';
import { formatDate } from '../../lib/utils.js';
import { ClockIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';

export default function AuditLogPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filterAction, setFilterAction] = useState('');

  const fetchLogs = async () => {
    try {
      setLoading(true);
      const params = { page, limit: 20 };
      if (filterAction) params.action = filterAction;

      const res = await api.get('/audit-logs', { params });
      setLogs(res.data || []);
      if (res.pagination) {
        setTotalPages(res.pagination.pages || 1);
      }
    } catch (err) {
      console.error('Failed to load audit logs', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [page, filterAction]);

  const getActionBadgeVariant = (action) => {
    if (action.startsWith('user.')) return 'info';
    if (action.startsWith('project.')) return 'primary';
    if (action.startsWith('issue.')) return 'success';
    if (action.startsWith('repository.')) return 'warning';
    return 'default';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2 text-primary-600 mb-1 text-xs font-semibold uppercase tracking-wider">
            <ShieldCheckIcon className="w-4 h-4" />
            <span>Application-Level Append-Only Log</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Audit Trail</h1>
          <p className="text-sm text-gray-500 mt-1">
            Immutable audit trail of all authentication, project modification, issue tracking, and
            VCS sync events
          </p>
        </div>

        <div>
          <select
            value={filterAction}
            onChange={(e) => {
              setFilterAction(e.target.value);
              setPage(1);
            }}
            className="text-xs font-medium border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 shadow-2xs focus:ring-2 focus:ring-primary-500"
          >
            <option value="">All Event Types</option>
            <option value="user.registered">User Registered</option>
            <option value="user.login">User Login</option>
            <option value="project.created">Project Created</option>
            <option value="project.updated">Project Updated</option>
            <option value="project.member.added">Member Added</option>
            <option value="issue.created">Issue Created</option>
            <option value="issue.status.changed">Status Changed</option>
            <option value="issue.commented">Issue Commented</option>
            <option value="repository.connected">Repository Connected</option>
            <option value="repository.synced">Repository Synced</option>
          </select>
        </div>
      </div>

      <Card>
        {loading ? (
          <LoadingSpinner size="lg" label="Loading audit logs..." />
        ) : logs.length > 0 ? (
          <div className="divide-y divide-gray-100 -mx-6 -my-6">
            <div className="bg-gray-50/80 px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider grid grid-cols-12 gap-4">
              <span className="col-span-3">Event Action</span>
              <span className="col-span-3">Actor</span>
              <span className="col-span-4">Entity Details</span>
              <span className="col-span-2 text-right">Timestamp</span>
            </div>

            {logs.map((log) => (
              <div
                key={log._id}
                className="px-6 py-3.5 text-xs grid grid-cols-12 gap-4 items-center hover:bg-gray-50/50 transition-colors"
              >
                <div className="col-span-3 flex items-center space-x-2">
                  <Badge variant={getActionBadgeVariant(log.action)} size="sm">
                    {log.action}
                  </Badge>
                </div>

                <div className="col-span-3 flex items-center space-x-2">
                  <Avatar user={log.actor} size="sm" />
                  <span className="font-semibold text-gray-900 truncate">
                    {log.actor
                      ? `${log.actor.firstName || ''} ${log.actor.lastName || ''}`.trim() ||
                        log.actor.email
                      : 'System / Automated'}
                  </span>
                </div>

                <div className="col-span-4 text-gray-600 font-mono text-[11px] truncate">
                  {log.metadata && Object.keys(log.metadata).length > 0
                    ? JSON.stringify(log.metadata)
                    : `${log.entityType} (${log.entityId?.substring(0, 8) || 'N/A'})`}
                </div>

                <div className="col-span-2 text-right text-gray-500">
                  {formatDate(log.createdAt)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-gray-500 text-sm">
            <ClockIcon className="w-8 h-8 mx-auto text-gray-400 mb-2" />
            No audit records found matching the filter.
          </div>
        )}
      </Card>

      {/* Pagination Bar */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 bg-white text-gray-700 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-gray-500">
            Page {page} of {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 bg-white text-gray-700 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

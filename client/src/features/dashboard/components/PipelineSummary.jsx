import {
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
  ClockIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/solid';
import { cn, formatDate } from '../../../lib/utils.js';

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} minutes ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hours ago`;
  return `${Math.floor(diffSec / 86400)} days ago`;
}

const conclusionConfig = {
  success: {
    icon: CheckCircleIcon,
    color: 'text-emerald-500',
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    label: 'PASSED',
  },
  failure: {
    icon: XCircleIcon,
    color: 'text-red-500',
    bg: 'bg-red-50',
    border: 'border-red-200',
    label: 'FAILED',
  },
  cancelled: {
    icon: XCircleIcon,
    color: 'text-gray-400',
    bg: 'bg-gray-50',
    border: 'border-gray-200',
    label: 'CANCELLED',
  },
  timed_out: {
    icon: ClockIcon,
    color: 'text-amber-500',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    label: 'TIMED OUT',
  },
};

export default function PipelineSummary({ pipelineStats = {}, recentPipelineRuns = [] }) {
  const { passing = 0, failing = 0, running = 0, queued = 0 } = pipelineStats;

  return (
    <div className="space-y-5">
      {/* Health Counters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <HealthCounter label="Passing" count={passing} color="emerald" />
        <HealthCounter label="Failing" count={failing} color="red" />
        <HealthCounter label="Running" count={running} color="blue" />
        <HealthCounter label="Queued" count={queued} color="gray" />
      </div>

      {/* Recent Runs */}
      {recentPipelineRuns.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">
          No pipeline runs yet. Connect a GitHub Actions workflow to see CI results here.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {recentPipelineRuns.map((run) => {
            const cfg = conclusionConfig[run.conclusion] || {};
            const StatusIcon =
              run.status === 'in_progress'
                ? ArrowPathIcon
                : run.status === 'queued'
                  ? ClockIcon
                  : cfg.icon || ClockIcon;

            return (
              <li key={run._id} className="py-3 flex items-start space-x-3">
                <div className="flex-shrink-0 mt-0.5">
                  <StatusIcon
                    className={cn(
                      'w-5 h-5',
                      run.status === 'in_progress' && 'text-blue-500 animate-spin',
                      run.status === 'queued' && 'text-gray-400',
                      run.status === 'completed' && (cfg.color || 'text-gray-400')
                    )}
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-900 truncate">
                      #{run.runNumber}{' '}
                      <span className="font-normal text-gray-600">{run.branch}</span>
                    </span>
                    {run.status === 'completed' && cfg.label && (
                      <span
                        className={cn(
                          'text-[10px] font-bold px-2 py-0.5 rounded-full border',
                          cfg.bg,
                          cfg.color,
                          cfg.border
                        )}
                      >
                        {cfg.label}
                      </span>
                    )}
                    {run.status === 'in_progress' && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-blue-50 text-blue-600 border-blue-200">
                        RUNNING
                      </span>
                    )}
                    {run.status === 'queued' && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">
                        QUEUED
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-gray-500 mt-0.5 truncate">{run.workflowName}</p>

                  <div className="flex items-center mt-1 text-[11px] text-gray-400 space-x-3">
                    {run.duration != null && <span>{formatDuration(run.duration)}</span>}
                    <span>{timeAgo(run.startedAt || run.createdAt)}</span>
                    {run.htmlUrl && (
                      <a
                        href={run.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center text-primary-500 hover:text-primary-700"
                      >
                        <ArrowTopRightOnSquareIcon className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function HealthCounter({ label, count, color }) {
  const colorMap = {
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    gray: 'bg-gray-50 text-gray-600 border-gray-200',
  };

  return (
    <div className={cn('rounded-lg border px-3 py-2 text-center', colorMap[color])}>
      <div className="text-xl font-bold">{count}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider">{label}</div>
    </div>
  );
}

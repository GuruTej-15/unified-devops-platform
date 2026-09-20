import {
  ShieldCheckIcon,
  ShieldExclamationIcon,
  ExclamationTriangleIcon,
  ClockIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/solid';
import Card from '../../../components/ui/Card.jsx';
import { cn, formatDate } from '../../../lib/utils.js';

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

export default function SecurityStatusSection({ security = {} }) {
  const {
    status = 'NOT_STARTED',
    scanStatus = null,
    latestScan = null,
    findingsSummary = null,
    lastEvaluatedAt = null,
    error = null,
  } = security || {};

  const isCompleted = status === 'PASSED';
  const isFailed = status === 'FAILED';
  const isProcessing = status === 'PROCESSING' || scanStatus === 'processing';
  const isError = status === 'ERROR' || scanStatus === 'failed';
  const isNotEvaluated = status === 'NOT_EVALUATED';
  const isNotStarted = status === 'NOT_STARTED' || !latestScan;

  // Status badge visual mapping
  const badgeConfig = {
    PASSED: {
      label: 'PASSED',
      bg: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      icon: ShieldCheckIcon,
      iconColor: 'text-emerald-500',
    },
    FAILED: {
      label: 'FAILED',
      bg: 'bg-red-50 text-red-700 border-red-200',
      icon: ShieldExclamationIcon,
      iconColor: 'text-red-500',
    },
    PROCESSING: {
      label: 'PROCESSING',
      bg: 'bg-blue-50 text-blue-700 border-blue-200',
      icon: ArrowPathIcon,
      iconColor: 'text-blue-500 animate-spin',
    },
    ERROR: {
      label: 'ERROR',
      bg: 'bg-red-50 text-red-700 border-red-200',
      icon: ExclamationTriangleIcon,
      iconColor: 'text-red-500',
    },
    NOT_EVALUATED: {
      label: 'NOT EVALUATED',
      bg: 'bg-slate-50 text-slate-700 border-slate-200',
      icon: ClockIcon,
      iconColor: 'text-slate-400',
    },
    NOT_STARTED: {
      label: 'NOT STARTED',
      bg: 'bg-gray-50 text-gray-600 border-gray-200',
      icon: ClockIcon,
      iconColor: 'text-gray-400',
    },
  }[status] || {
    label: status,
    bg: 'bg-gray-50 text-gray-600 border-gray-200',
    icon: ClockIcon,
    iconColor: 'text-gray-400',
  };

  const BadgeIcon = badgeConfig.icon;
  const summary = findingsSummary || latestScan?.summary || null;

  return (
    <Card
      title={
        <div className="flex items-center space-x-2">
          <ShieldCheckIcon className="w-5 h-5 text-gray-700" />
          <span>Security Scan</span>
        </div>
      }
      action={
        <span
          className={cn(
            'text-[11px] font-semibold px-2.5 py-0.5 rounded-full border inline-flex items-center space-x-1 font-mono',
            badgeConfig.bg
          )}
          data-testid="security-status-badge"
        >
          <BadgeIcon className={cn('w-3.5 h-3.5 mr-1', badgeConfig.iconColor)} />
          {badgeConfig.label}
        </span>
      }
    >
      {isNotStarted ? (
        <div className="text-center py-6">
          <ClockIcon className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-700">No Security Scan Linked</p>
          <p className="text-xs text-gray-400 mt-1 max-w-sm mx-auto">
            Runs associated with this issue&apos;s commits or pull requests will automatically
            ingest security reports and evaluate policy gates.
          </p>
        </div>
      ) : isProcessing ? (
        <div className="text-center py-6">
          <ArrowPathIcon className="w-8 h-8 text-blue-500 animate-spin mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-800">Scan In Progress</p>
          <p className="text-xs text-gray-500 mt-1">
            Analyzing container image or filesystem vulnerabilities via Trivy...
          </p>
        </div>
      ) : isError ? (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4">
          <div className="flex items-start space-x-3">
            <ExclamationTriangleIcon className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-red-800 uppercase tracking-wide">
                Security Scan Failed
              </p>
              <p className="text-xs text-red-700 mt-0.5 font-mono">
                {error || latestScan?.errorMessage || 'Scan processing encountered an error.'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-50/70 p-3 rounded-lg border border-slate-100">
            <div>
              <span className="text-gray-400 uppercase tracking-wider text-[10px] font-medium block">
                Provider
              </span>
              <span className="font-semibold text-gray-800 uppercase font-mono">
                {latestScan?.provider || '—'}
              </span>
            </div>
            <div>
              <span className="text-gray-400 uppercase tracking-wider text-[10px] font-medium block">
                Scan Type
              </span>
              <span className="font-semibold text-gray-800 capitalize font-mono">
                {latestScan?.scanType || '—'}
              </span>
            </div>
            <div>
              <span className="text-gray-400 uppercase tracking-wider text-[10px] font-medium block">
                Target
              </span>
              <span
                className="font-semibold text-gray-800 truncate block font-mono"
                title={latestScan?.target}
              >
                {latestScan?.target || '—'}
              </span>
            </div>
            <div>
              <span className="text-gray-400 uppercase tracking-wider text-[10px] font-medium block">
                Completed
              </span>
              <span className="font-medium text-gray-700">
                {lastEvaluatedAt || latestScan?.completedAt
                  ? formatDate(lastEvaluatedAt || latestScan?.completedAt)
                  : '—'}
              </span>
            </div>
          </div>

          {/* Vulnerability Findings Summary */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                Findings Summary
              </span>
              <span className="text-xs font-mono font-bold text-gray-800">
                {summary ? `${summary.total ?? 0} Total Finding(s)` : '0 Findings'}
              </span>
            </div>

            {summary ? (
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                <div className="rounded-lg bg-red-50 border border-red-100 p-2 text-center">
                  <span className="text-[10px] font-semibold uppercase text-red-600 tracking-wider block">
                    Critical
                  </span>
                  <span className="text-base font-bold text-red-700 font-mono">
                    {summary.critical ?? 0}
                  </span>
                </div>
                <div className="rounded-lg bg-orange-50 border border-orange-100 p-2 text-center">
                  <span className="text-[10px] font-semibold uppercase text-orange-600 tracking-wider block">
                    High
                  </span>
                  <span className="text-base font-bold text-orange-700 font-mono">
                    {summary.high ?? 0}
                  </span>
                </div>
                <div className="rounded-lg bg-amber-50 border border-amber-100 p-2 text-center">
                  <span className="text-[10px] font-semibold uppercase text-amber-600 tracking-wider block">
                    Medium
                  </span>
                  <span className="text-base font-bold text-amber-700 font-mono">
                    {summary.medium ?? 0}
                  </span>
                </div>
                <div className="rounded-lg bg-blue-50 border border-blue-100 p-2 text-center">
                  <span className="text-[10px] font-semibold uppercase text-blue-600 tracking-wider block">
                    Low
                  </span>
                  <span className="text-base font-bold text-blue-700 font-mono">
                    {summary.low ?? 0}
                  </span>
                </div>
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-2 text-center">
                  <span className="text-[10px] font-semibold uppercase text-slate-600 tracking-wider block">
                    Negligible
                  </span>
                  <span className="text-base font-bold text-slate-700 font-mono">
                    {summary.negligible ?? 0}
                  </span>
                </div>
                <div className="rounded-lg bg-gray-50 border border-gray-200 p-2 text-center">
                  <span className="text-[10px] font-semibold uppercase text-gray-600 tracking-wider block">
                    Unknown
                  </span>
                  <span className="text-base font-bold text-gray-700 font-mono">
                    {summary.unknown ?? 0}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic">No finding summary data available.</p>
            )}

            <p className="text-[11px] text-gray-400 mt-2 italic">
              Note: Vulnerability presence represents security scanner findings. Delivery gate
              compliance is governed by the policy rules below.
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

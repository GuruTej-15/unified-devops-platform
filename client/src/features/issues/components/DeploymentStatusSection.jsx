import {
  RocketLaunchIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
  ArrowTopRightOnSquareIcon,
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

function formatProvider(provider) {
  if (!provider) return 'Generic';
  switch (provider.toLowerCase()) {
    case 'github_actions':
      return 'GitHub Actions';
    case 'jenkins':
      return 'Jenkins';
    case 'generic':
      return 'Generic CI/CD';
    default:
      return provider.toUpperCase();
  }
}

export default function DeploymentStatusSection({ deployment = {} }) {
  const {
    status = 'NOT_STARTED',
    environment = null,
    governanceDecision = null,
    isGovernanceViolation = false,
    latestDeployment = null,
  } = deployment || {};

  const depStatus = (latestDeployment?.status || status || 'NOT_STARTED').toLowerCase();

  // Status badge config
  const statusBadgeConfig = {
    success: {
      label: 'SUCCESS',
      bg: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      icon: CheckCircleIcon,
      iconColor: 'text-emerald-500',
    },
    completed: {
      label: 'SUCCESS',
      bg: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      icon: CheckCircleIcon,
      iconColor: 'text-emerald-500',
    },
    in_progress: {
      label: 'IN PROGRESS',
      bg: 'bg-blue-50 text-blue-700 border-blue-200',
      icon: ArrowPathIcon,
      iconColor: 'text-blue-500 animate-spin',
    },
    active: {
      label: 'IN PROGRESS',
      bg: 'bg-blue-50 text-blue-700 border-blue-200',
      icon: ArrowPathIcon,
      iconColor: 'text-blue-500 animate-spin',
    },
    queued: {
      label: 'QUEUED',
      bg: 'bg-sky-50 text-sky-700 border-sky-200',
      icon: ClockIcon,
      iconColor: 'text-sky-500',
    },
    failed: {
      label: 'FAILED',
      bg: 'bg-red-50 text-red-700 border-red-200',
      icon: XCircleIcon,
      iconColor: 'text-red-500',
    },
    cancelled: {
      label: 'CANCELLED',
      bg: 'bg-gray-100 text-gray-700 border-gray-300',
      icon: XCircleIcon,
      iconColor: 'text-gray-400',
    },
    pending: {
      label: 'PENDING',
      bg: 'bg-gray-50 text-gray-600 border-gray-200',
      icon: ClockIcon,
      iconColor: 'text-gray-400',
    },
    not_started: {
      label: 'NOT DEPLOYED',
      bg: 'bg-gray-50 text-gray-600 border-gray-200',
      icon: ClockIcon,
      iconColor: 'text-gray-400',
    },
  }[depStatus] || {
    label: depStatus.toUpperCase(),
    bg: 'bg-gray-50 text-gray-600 border-gray-200',
    icon: ClockIcon,
    iconColor: 'text-gray-400',
  };

  // Governance decision badge config
  const govDecision = latestDeployment?.governanceDecision || governanceDecision || 'NOT_EVALUATED';
  const govBadgeConfig = {
    ALLOWED: {
      label: 'ALLOWED',
      bg: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      icon: ShieldCheckIcon,
      iconColor: 'text-emerald-500',
      desc: 'Governance evaluation passed — all release policies satisfied.',
    },
    BLOCKED: {
      label: 'BLOCKED',
      bg: 'bg-red-50 text-red-700 border-red-200',
      icon: ShieldExclamationIcon,
      iconColor: 'text-red-500',
      desc: 'Governance evaluation says deployment should be blocked.',
    },
    OVERRIDDEN: {
      label: 'OVERRIDDEN',
      bg: 'bg-amber-50 text-amber-700 border-amber-200',
      icon: ExclamationTriangleIcon,
      iconColor: 'text-amber-500',
      desc: 'Governance exception active — policy gate was manually overridden.',
    },
    NOT_EVALUATED: {
      label: 'NOT EVALUATED',
      bg: 'bg-slate-50 text-slate-600 border-slate-200',
      icon: ClockIcon,
      iconColor: 'text-slate-400',
      desc: 'No security scan or policy gate was evaluated for this commit/pipeline.',
    },
  }[govDecision] || {
    label: govDecision,
    bg: 'bg-slate-50 text-slate-600 border-slate-200',
    icon: ClockIcon,
    iconColor: 'text-slate-400',
    desc: 'Governance evaluation status unknown.',
  };

  const StatusIcon = statusBadgeConfig.icon;
  const GovIcon = govBadgeConfig.icon;
  const hasDeployment = Boolean(latestDeployment);

  return (
    <Card
      title={
        <div className="flex items-center space-x-2">
          <RocketLaunchIcon className="w-5 h-5 text-gray-700" />
          <span>Deployment & Release Governance</span>
        </div>
      }
      action={
        <span
          className={cn(
            'text-[11px] font-semibold px-2.5 py-0.5 rounded-full border inline-flex items-center space-x-1 font-mono',
            statusBadgeConfig.bg
          )}
          data-testid="deployment-status-badge"
        >
          <StatusIcon className={cn('w-3.5 h-3.5 mr-1', statusBadgeConfig.iconColor)} />
          {statusBadgeConfig.label}
        </span>
      }
    >
      <div className="space-y-4">
        {/* Governance Violation Alert Banner */}
        {isGovernanceViolation && (
          <div
            className="p-3.5 bg-red-50 border border-red-200 rounded-lg flex items-start space-x-3"
            data-testid="deployment-governance-violation-alert"
          >
            <ExclamationTriangleIcon className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
            <div>
              <h4 className="text-xs font-bold text-red-800 uppercase tracking-wide">
                Governance Policy Violation
              </h4>
              <p className="text-xs text-red-700 mt-0.5">
                Deployment completed externally despite governance policy violation. The external
                deployment succeeded, but security policy gates were BLOCKED.
              </p>
            </div>
          </div>
        )}

        {/* Governance Evaluation Banner */}
        <div
          className="p-3.5 bg-gray-50 border border-gray-200/80 rounded-lg flex items-center justify-between"
          data-testid="deployment-governance-decision-card"
        >
          <div className="flex items-center space-x-2.5">
            <GovIcon className={cn('w-5 h-5 shrink-0', govBadgeConfig.iconColor)} />
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-xs font-bold text-gray-800">Governance Decision:</span>
                <span
                  className={cn(
                    'text-[10px] font-bold px-2 py-0.5 rounded border uppercase font-mono',
                    govBadgeConfig.bg
                  )}
                  data-testid="deployment-governance-badge"
                >
                  {govBadgeConfig.label}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{govBadgeConfig.desc}</p>
            </div>
          </div>
        </div>

        {/* Deployment Details Grid or Empty State */}
        {hasDeployment ? (
          <div className="space-y-3" data-testid="deployment-details-section">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-gray-50/70 p-3.5 rounded-lg border border-gray-100">
              <div>
                <span className="text-[11px] text-gray-500 block uppercase font-medium">
                  Environment
                </span>
                <span className="text-xs font-bold text-gray-800 uppercase font-mono mt-0.5 block">
                  {latestDeployment.environment || environment || '—'}
                </span>
              </div>

              <div>
                <span className="text-[11px] text-gray-500 block uppercase font-medium">
                  Provider
                </span>
                <span className="text-xs font-bold text-gray-800 mt-0.5 block">
                  {formatProvider(latestDeployment.provider)}
                </span>
              </div>

              <div>
                <span className="text-[11px] text-gray-500 block uppercase font-medium">
                  Commit
                </span>
                <span className="text-xs font-mono font-bold text-gray-800 mt-0.5 block">
                  {latestDeployment.commitSha ? latestDeployment.commitSha.substring(0, 7) : '—'}
                </span>
              </div>

              <div>
                <span className="text-[11px] text-gray-500 block uppercase font-medium">
                  Duration
                </span>
                <span className="text-xs font-bold text-gray-800 mt-0.5 block">
                  {formatDuration(latestDeployment.duration)}
                </span>
              </div>
            </div>

            {/* Extended Metadata */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-gray-600 px-1">
              <div className="flex items-center justify-between py-1 border-b border-gray-100">
                <span className="text-gray-500">External ID:</span>
                <span className="font-mono text-gray-800 font-medium">
                  {latestDeployment.externalDeploymentId || '—'}
                </span>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-gray-100">
                <span className="text-gray-500">Branch:</span>
                <span className="font-mono text-gray-800 font-medium">
                  {latestDeployment.branch || '—'}
                </span>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-gray-100">
                <span className="text-gray-500">Deployed By:</span>
                <span className="text-gray-800 font-medium">{latestDeployment.actor || '—'}</span>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-gray-100">
                <span className="text-gray-500">Timestamp:</span>
                <span className="text-gray-800 font-medium">
                  {formatDate(latestDeployment.completedAt || latestDeployment.startedAt)}
                </span>
              </div>
            </div>

            {/* External URL if provided */}
            {latestDeployment.url && (
              <div className="pt-1 flex items-center justify-end">
                <a
                  href={latestDeployment.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center space-x-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
                >
                  <span>View in {formatProvider(latestDeployment.provider)}</span>
                  <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                </a>
              </div>
            )}
          </div>
        ) : (
          <div
            className="text-center py-6 px-4 bg-gray-50/50 rounded-lg border border-dashed border-gray-200"
            data-testid="deployment-empty-state"
          >
            <RocketLaunchIcon className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-xs font-semibold text-gray-700">No Deployment Recorded</p>
            <p className="text-[11px] text-gray-400 mt-1 max-w-sm mx-auto">
              Once an automated pipeline or CI/CD deployment runs for this issue, deployment
              tracking and release governance results will appear here in real time.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

import {
  CheckCircleIcon,
  XCircleIcon,
  ExclamationTriangleIcon,
  ClockIcon,
  ScaleIcon,
  KeyIcon,
} from '@heroicons/react/24/solid';
import Card from '../../../components/ui/Card.jsx';
import { cn, formatDate } from '../../../lib/utils.js';

export default function GovernanceGateSection({ governance = {} }) {
  const {
    status = 'NOT_STARTED',
    blockingFailures = 0,
    warnings = 0,
    notEvaluated = 0,
    passed = 0,
    overridden = false,
    overrideCount = 0,
    isFullyOverridden = false,
    policies = [],
  } = governance || {};

  const isNotStarted = status === 'NOT_STARTED' && policies.length === 0;

  // Status badge visual mapping
  const badgeConfig = {
    PASS: {
      label: 'PASS',
      bg: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      icon: CheckCircleIcon,
      iconColor: 'text-emerald-500',
    },
    FAIL: {
      label: overridden ? 'FAIL (OVERRIDDEN)' : 'FAIL',
      bg: overridden
        ? 'bg-purple-50 text-purple-700 border-purple-200'
        : 'bg-red-50 text-red-700 border-red-200',
      icon: overridden ? KeyIcon : XCircleIcon,
      iconColor: overridden ? 'text-purple-500' : 'text-red-500',
    },
    WARNING: {
      label: 'WARNING',
      bg: 'bg-amber-50 text-amber-700 border-amber-200',
      icon: ExclamationTriangleIcon,
      iconColor: 'text-amber-500',
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

  function formatRuleType(ruleType) {
    if (ruleType === 'max_severity_count') return 'Vulnerability Threshold';
    if (ruleType === 'required_scan') return 'Scan Age Cadence';
    return ruleType || 'Policy Rule';
  }

  return (
    <Card
      title={
        <div className="flex items-center space-x-2">
          <ScaleIcon className="w-5 h-5 text-gray-700" />
          <span>Governance Policy Gates</span>
        </div>
      }
      action={
        <span
          className={cn(
            'text-[11px] font-semibold px-2.5 py-0.5 rounded-full border inline-flex items-center space-x-1 font-mono',
            badgeConfig.bg
          )}
          data-testid="governance-status-badge"
        >
          <BadgeIcon className={cn('w-3.5 h-3.5 mr-1', badgeConfig.iconColor)} />
          {badgeConfig.label}
        </span>
      }
    >
      {isNotStarted ? (
        <div className="text-center py-6">
          <ClockIcon className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-700">No Policy Evaluation Recorded</p>
          <p className="text-xs text-gray-400 mt-1 max-w-sm mx-auto">
            Governance policies (e.g. vulnerability thresholds or required scan cadences) evaluate
            automatically when a security scan completes.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Summary counters */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
            <div className="p-2 rounded-lg bg-emerald-50/70 border border-emerald-100">
              <span className="text-[10px] uppercase font-semibold text-emerald-600 block">
                Passing
              </span>
              <span className="text-base font-bold text-emerald-700 font-mono">{passed}</span>
            </div>
            <div className="p-2 rounded-lg bg-red-50/70 border border-red-100">
              <span className="text-[10px] uppercase font-semibold text-red-600 block">
                Blocking Failures
              </span>
              <span className="text-base font-bold text-red-700 font-mono">{blockingFailures}</span>
            </div>
            <div className="p-2 rounded-lg bg-amber-50/70 border border-amber-100">
              <span className="text-[10px] uppercase font-semibold text-amber-600 block">
                Advisory Warnings
              </span>
              <span className="text-base font-bold text-amber-700 font-mono">{warnings}</span>
            </div>
            <div className="p-2 rounded-lg bg-purple-50/70 border border-purple-100">
              <span className="text-[10px] uppercase font-semibold text-purple-600 block">
                Overridden
              </span>
              <span className="text-base font-bold text-purple-700 font-mono">{overrideCount}</span>
            </div>
          </div>

          {/* Fully Overridden Banner if applicable */}
          {isFullyOverridden && (
            <div className="rounded-lg bg-purple-50 border border-purple-200 p-3 text-xs flex items-start space-x-2">
              <KeyIcon className="w-4 h-4 text-purple-600 mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold text-purple-900">
                  Manual Governance Exception Approved
                </p>
                <p className="text-purple-700 mt-0.5">
                  All blocking policy gate failures for this scan have been manually authorized by a
                  security administrator. Original audit records are preserved.
                </p>
              </div>
            </div>
          )}

          {/* Policy Evaluation List */}
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 block mb-2">
              Policy Breakdown ({policies.length} Evaluated)
            </span>

            {policies.length === 0 ? (
              <p className="text-xs text-gray-400 italic">
                No active project policies were configured during this evaluation.
              </p>
            ) : (
              <div className="space-y-2">
                {policies.map((p, idx) => {
                  const policyPassed = p.passed;
                  const isWarning = p.evaluationStatus === 'WARNING';
                  const isFail = p.evaluationStatus === 'FAIL';
                  const isNotEval = p.evaluationStatus === 'NOT_EVALUATED';

                  return (
                    <div
                      key={p.policyId || idx}
                      className={cn(
                        'p-3 rounded-lg border text-xs transition-colors',
                        p.isOverridden
                          ? 'bg-purple-50/40 border-purple-200'
                          : isFail
                            ? 'bg-red-50/40 border-red-200'
                            : isWarning
                              ? 'bg-amber-50/40 border-amber-200'
                              : isNotEval
                                ? 'bg-slate-50 border-slate-200'
                                : 'bg-slate-50/60 border-slate-200'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center space-x-2 min-w-0">
                          {policyPassed ? (
                            <CheckCircleIcon className="w-4 h-4 text-emerald-500 shrink-0" />
                          ) : isFail ? (
                            <XCircleIcon className="w-4 h-4 text-red-500 shrink-0" />
                          ) : isWarning ? (
                            <ExclamationTriangleIcon className="w-4 h-4 text-amber-500 shrink-0" />
                          ) : (
                            <ClockIcon className="w-4 h-4 text-slate-400 shrink-0" />
                          )}
                          <span className="font-semibold text-gray-900 truncate">
                            {p.policyName || 'Policy Rule'}
                          </span>
                          <span className="text-[10px] text-gray-500 font-mono">
                            • {formatRuleType(p.ruleType)}
                          </span>
                        </div>

                        <div className="flex items-center space-x-1.5 shrink-0">
                          <span
                            className={cn(
                              'text-[10px] px-1.5 py-0.5 rounded font-medium uppercase',
                              p.enforcement === 'blocking'
                                ? 'bg-slate-200 text-slate-700'
                                : 'bg-amber-100 text-amber-700'
                            )}
                          >
                            {p.enforcement}
                          </span>
                          <span
                            className={cn(
                              'text-[10px] px-2 py-0.5 rounded-full font-bold uppercase font-mono',
                              p.evaluationStatus === 'PASS' && 'bg-emerald-100 text-emerald-800',
                              p.evaluationStatus === 'FAIL' && 'bg-red-100 text-red-800',
                              p.evaluationStatus === 'WARNING' && 'bg-amber-100 text-amber-800',
                              p.evaluationStatus === 'NOT_EVALUATED' &&
                                'bg-slate-100 text-slate-800'
                            )}
                          >
                            {p.evaluationStatus}
                          </span>
                        </div>
                      </div>

                      {/* Reason */}
                      <p className="mt-1 text-gray-600 font-mono text-[11px] pl-6">
                        {p.reason || 'Evaluation completed'}
                      </p>

                      {/* Override Details if applicable */}
                      {p.isOverridden && (
                        <div className="mt-2 ml-6 p-2 rounded bg-purple-100/60 border border-purple-200 text-[11px]">
                          <div className="flex items-center space-x-1 text-purple-900 font-semibold mb-0.5">
                            <KeyIcon className="w-3.5 h-3.5" />
                            <span>Manual Exception Applied</span>
                          </div>
                          <p className="text-purple-800 italic">
                            &ldquo;{p.overrideJustification}&rdquo;
                          </p>
                          {p.overriddenAt && (
                            <span className="text-[10px] text-purple-600 mt-1 block">
                              Recorded on {formatDate(p.overriddenAt)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

import {
  CheckCircleIcon,
  ClockIcon,
  ArrowTopRightOnSquareIcon,
  XCircleIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/solid';
import { cn, formatDate } from '../../../lib/utils.js';

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

export default function DeliveryStateTracker({ issue, activity = {} }) {
  const { commits = [], pullRequests = [], branches = [], pipelineRuns = [] } = activity;

  const hasCommits = commits.length > 0;
  const hasPR = pullRequests.length > 0;
  const hasBranch = branches.length > 0 || (hasPR && pullRequests.some((p) => p.sourceBranch));
  const hasPipeline = pipelineRuns.length > 0;

  const latestPR = pullRequests[0];
  const latestCommit = commits[0];
  const latestRun = pipelineRuns[0];

  // Determine CI stage status from real pipeline data
  let ciStatus = 'pending';
  let ciTitle = 'No CI pipeline runs linked yet';
  let ciDetail = 'Push a commit with issue key to trigger GitHub Actions';
  let ciBadge = 'Pending';
  let ciUrl = null;

  if (hasPipeline) {
    ciUrl = latestRun.htmlUrl;

    if (latestRun.status === 'completed') {
      if (latestRun.conclusion === 'success') {
        ciStatus = 'completed';
        ciTitle = `✓ #${latestRun.runNumber} ${latestRun.workflowName}`;
        ciDetail = `Passed on ${latestRun.branch}${latestRun.duration != null ? ` • ${formatDuration(latestRun.duration)}` : ''}`;
        ciBadge = 'PASSED';
      } else {
        ciStatus = 'failed';
        ciTitle = `✕ #${latestRun.runNumber} ${latestRun.workflowName}`;
        ciDetail = `${(latestRun.conclusion || 'failed').toUpperCase()} on ${latestRun.branch}${latestRun.duration != null ? ` • ${formatDuration(latestRun.duration)}` : ''}`;
        ciBadge = (latestRun.conclusion || 'FAILED').toUpperCase();
      }
    } else if (latestRun.status === 'in_progress') {
      ciStatus = 'active';
      ciTitle = `● #${latestRun.runNumber} ${latestRun.workflowName}`;
      ciDetail = `Running on ${latestRun.branch}`;
      ciBadge = 'Running';
    } else {
      ciStatus = 'active';
      ciTitle = `◌ #${latestRun.runNumber} ${latestRun.workflowName}`;
      ciDetail = `Queued on ${latestRun.branch}`;
      ciBadge = 'Queued';
    }
  }

  const stages = [
    {
      id: 'issue',
      name: 'Issue',
      status: 'completed',
      title: `${issue.issueKey} Created`,
      detail: `Reported by ${issue.reporter ? `${issue.reporter.firstName || ''} ${issue.reporter.lastName || ''}`.trim() : 'User'} on ${formatDate(issue.createdAt)}`,
      badge: issue.status,
    },
    {
      id: 'branch',
      name: 'Branch',
      status: hasBranch ? 'completed' : 'pending',
      title: hasBranch
        ? branches[0] || latestPR?.sourceBranch || 'Branch detected'
        : 'No branch associated',
      detail: hasBranch
        ? 'VCS branch tracked'
        : 'Commit or create PR with issue key in branch name',
      badge: hasBranch ? 'Detected' : 'Pending',
    },
    {
      id: 'commit',
      name: 'Commits',
      status: hasCommits ? 'completed' : 'pending',
      title: hasCommits ? `${commits.length} commit(s) linked` : 'No commits detected',
      detail: latestCommit
        ? `Latest: ${latestCommit.sha?.substring(0, 7)} — "${latestCommit.message}"`
        : 'Include issue key in commit messages (e.g. "PAY-101: fix")',
      badge: hasCommits ? `${commits.length} commits` : 'Pending',
    },
    {
      id: 'pr',
      name: 'Pull Request',
      status: hasPR ? (latestPR.state === 'merged' ? 'completed' : 'active') : 'pending',
      title: latestPR ? `PR #${latestPR.number}: ${latestPR.title}` : 'No pull request associated',
      detail: latestPR
        ? `Status: ${latestPR.state.toUpperCase()} • ${latestPR.sourceBranch} → ${latestPR.targetBranch}`
        : 'Create PR referencing this issue',
      url: latestPR?.url,
      badge: latestPR ? latestPR.state.toUpperCase() : 'Pending',
    },
    {
      id: 'ci',
      name: 'CI / Build Pipeline',
      status: ciStatus,
      title: ciTitle,
      detail: ciDetail,
      badge: ciBadge,
      url: ciUrl,
    },
    {
      id: 'security',
      name: 'Security & Governance',
      status: 'future',
      phase: 'Phase 3',
      title: 'Trivy / Snyk security scan gates & policy approval',
      detail: 'Vulnerability analysis, license compliance, and required approval sign-offs',
      badge: 'Phase 3',
    },
    {
      id: 'deployment',
      name: 'Deployment',
      status: 'future',
      phase: 'Phase 4',
      title: 'Docker / Kubernetes release rollout',
      detail: 'Target cluster environment deployment and live service health monitoring',
      badge: 'Phase 4',
    },
  ];

  return (
    <div className="bg-white rounded-xl border border-gray-200/80 p-6 shadow-xs">
      <div className="flex items-center justify-between pb-4 border-b border-gray-100">
        <div>
          <h3 className="text-base font-bold text-gray-900">End-to-End Delivery State</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Unified delivery pipeline state across source control, issue tracking, CI, and future
            execution gates
          </p>
        </div>
      </div>

      <div className="mt-6 flow-root">
        <ul className="-mb-8">
          {stages.map((stage, idx) => {
            const isLast = idx === stages.length - 1;

            const isCompleted = stage.status === 'completed';
            const isActive = stage.status === 'active';
            const isPending = stage.status === 'pending';
            const isFuture = stage.status === 'future';
            const isFailed = stage.status === 'failed';

            return (
              <li key={stage.id}>
                <div className="relative pb-8">
                  {!isLast && (
                    <span
                      className={cn(
                        'absolute top-4 left-4 -ml-px h-full w-0.5',
                        isCompleted
                          ? 'bg-primary-600'
                          : isFuture
                            ? 'bg-gray-200 border-dashed'
                            : isFailed
                              ? 'bg-red-300'
                              : 'bg-gray-200'
                      )}
                      aria-hidden="true"
                    />
                  )}

                  <div className="relative flex items-start space-x-3">
                    {/* Step Icon */}
                    <div>
                      {isCompleted ? (
                        <div className="h-8 w-8 rounded-full bg-emerald-500 flex items-center justify-center text-white ring-4 ring-white shadow-xs">
                          <CheckCircleIcon className="h-5 w-5" />
                        </div>
                      ) : isActive ? (
                        <div className="h-8 w-8 rounded-full bg-primary-600 flex items-center justify-center text-white ring-4 ring-white shadow-xs animate-pulse">
                          <ArrowPathIcon className="h-5 w-5" />
                        </div>
                      ) : isFailed ? (
                        <div className="h-8 w-8 rounded-full bg-red-500 flex items-center justify-center text-white ring-4 ring-white shadow-xs">
                          <XCircleIcon className="h-5 w-5" />
                        </div>
                      ) : isFuture ? (
                        <div className="h-8 w-8 rounded-full bg-slate-100 border border-slate-300 flex items-center justify-center text-slate-400 ring-4 ring-white text-xs font-bold">
                          ○
                        </div>
                      ) : (
                        <div className="h-8 w-8 rounded-full bg-gray-100 border border-gray-300 flex items-center justify-center text-gray-400 ring-4 ring-white">
                          <ClockIcon className="h-4 w-4" />
                        </div>
                      )}
                    </div>

                    {/* Step Content */}
                    <div className={cn('min-w-0 flex-1 pt-0.5', isFuture && 'opacity-60')}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-wider text-gray-500">
                          {stage.name}
                        </span>
                        <span
                          className={cn(
                            'text-[10px] font-semibold px-2 py-0.5 rounded-full border',
                            isCompleted && 'bg-emerald-50 text-emerald-700 border-emerald-200',
                            isActive && 'bg-primary-50 text-primary-700 border-primary-200',
                            isPending && 'bg-gray-50 text-gray-600 border-gray-200',
                            isFailed && 'bg-red-50 text-red-700 border-red-200',
                            isFuture && 'bg-slate-50 text-slate-500 border-slate-200 font-mono'
                          )}
                        >
                          {stage.badge}
                        </span>
                      </div>

                      <div className="mt-1">
                        <p className="text-sm font-semibold text-gray-900 flex items-center">
                          {stage.title}
                          {stage.url && (
                            <a
                              href={stage.url}
                              target="_blank"
                              rel="noreferrer"
                              className="ml-2 text-primary-600 hover:text-primary-700 inline-flex items-center text-xs"
                            >
                              <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5 font-mono">{stage.detail}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

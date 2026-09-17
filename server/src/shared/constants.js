/**
 * Application-wide constants and enums.
 */

export const USER_ROLES = {
  ADMIN: 'admin',
  DEVELOPER: 'developer',
  PRODUCT: 'product',
  QA: 'qa',
  SECURITY: 'security',
  OPERATIONS: 'operations',
};

export const USER_ROLE_VALUES = Object.values(USER_ROLES);

export const PROJECT_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
};

export const PROJECT_MEMBER_ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  DEVELOPER: 'developer',
  VIEWER: 'viewer',
};

export const PROJECT_MEMBER_ROLE_VALUES = Object.values(PROJECT_MEMBER_ROLES);

export const ISSUE_STATUS = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  IN_REVIEW: 'in_review',
  DONE: 'done',
  CLOSED: 'closed',
};

export const ISSUE_STATUS_VALUES = Object.values(ISSUE_STATUS);

export const ISSUE_PRIORITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

export const ISSUE_PRIORITY_VALUES = Object.values(ISSUE_PRIORITY);

export const ISSUE_TYPE = {
  TASK: 'task',
  BUG: 'bug',
  FEATURE: 'feature',
  IMPROVEMENT: 'improvement',
};

export const ISSUE_TYPE_VALUES = Object.values(ISSUE_TYPE);

export const VCS_PROVIDER = {
  GITHUB: 'github',
  GITLAB: 'gitlab',
};

export const CONNECTION_STATUS = {
  CONNECTED: 'connected',
  SYNCING: 'syncing',
  FAILED: 'failed',
  DISCONNECTED: 'disconnected',
};

export const SYNC_STATUS = {
  SUCCESS: 'success',
  PARTIAL: 'partial',
  FAILED: 'failed',
};

export const PR_STATE = {
  OPEN: 'open',
  CLOSED: 'closed',
  MERGED: 'merged',
};

// CI/CD Enums (Phase 2A)
export const CI_PROVIDER = {
  GITHUB_ACTIONS: 'github_actions',
  JENKINS: 'jenkins',
};

export const CI_PROVIDER_VALUES = Object.values(CI_PROVIDER);

export const PIPELINE_STATUS = {
  QUEUED: 'queued',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
};

export const PIPELINE_STATUS_VALUES = Object.values(PIPELINE_STATUS);

export const PIPELINE_CONCLUSION = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
  NEUTRAL: 'neutral',
  TIMED_OUT: 'timed_out',
  ACTION_REQUIRED: 'action_required',
};

export const PIPELINE_CONCLUSION_VALUES = Object.values(PIPELINE_CONCLUSION);

// Security Enums (Phase 3)
export const SECURITY_PROVIDER = {
  TRIVY: 'trivy',
  GENERIC: 'generic',
};

export const SECURITY_PROVIDER_VALUES = Object.values(SECURITY_PROVIDER);

export const SECURITY_SCAN_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

export const SECURITY_SCAN_STATUS_VALUES = Object.values(SECURITY_SCAN_STATUS);

export const SECURITY_SCAN_TYPE = {
  IMAGE: 'image',
  FILESYSTEM: 'filesystem',
  REPOSITORY: 'repository',
  CONFIG: 'config',
};

export const SECURITY_SCAN_TYPE_VALUES = Object.values(SECURITY_SCAN_TYPE);

export const SECURITY_SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  NEGLIGIBLE: 'negligible',
  UNKNOWN: 'unknown',
};

export const SECURITY_SEVERITY_VALUES = Object.values(SECURITY_SEVERITY);

export const SECURITY_FINDING_TYPE = {
  VULNERABILITY: 'vulnerability',
  MISCONFIGURATION: 'misconfiguration',
  SECRET: 'secret',
};

export const SECURITY_FINDING_TYPE_VALUES = Object.values(SECURITY_FINDING_TYPE);

export const SECURITY_FINDING_STATUS = {
  OPEN: 'open',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
  FALSE_POSITIVE: 'false_positive',
};

export const SECURITY_FINDING_STATUS_VALUES = Object.values(SECURITY_FINDING_STATUS);

export const POLICY_RULE_TYPE = {
  MAX_SEVERITY_COUNT: 'max_severity_count',
  REQUIRED_SCAN: 'required_scan',
};

export const POLICY_RULE_TYPE_VALUES = Object.values(POLICY_RULE_TYPE);

export const POLICY_ENFORCEMENT = {
  BLOCKING: 'blocking',
  WARNING: 'warning',
};

export const POLICY_ENFORCEMENT_VALUES = Object.values(POLICY_ENFORCEMENT);

export const POLICY_EVALUATION_STATE = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  WARNING: 'WARNING',
  NOT_EVALUATED: 'NOT_EVALUATED',
};

export const POLICY_EVALUATION_STATE_VALUES = Object.values(POLICY_EVALUATION_STATE);

export const AUDIT_ACTIONS = {
  // Auth
  USER_REGISTERED: 'user.registered',
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  USER_PROFILE_UPDATED: 'user.profile.updated',
  USER_PASSWORD_CHANGED: 'user.password.changed',

  // Projects
  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_ARCHIVED: 'project.archived',
  PROJECT_MEMBER_ADDED: 'project.member.added',
  PROJECT_MEMBER_REMOVED: 'project.member.removed',
  PROJECT_MEMBER_ROLE_UPDATED: 'project.member.role.updated',

  // Issues
  ISSUE_CREATED: 'issue.created',
  ISSUE_UPDATED: 'issue.updated',
  ISSUE_DELETED: 'issue.deleted',
  ISSUE_ASSIGNED: 'issue.assigned',
  ISSUE_STATUS_CHANGED: 'issue.status.changed',
  ISSUE_COMMENTED: 'issue.commented',

  // VCS
  REPOSITORY_CONNECTED: 'repository.connected',
  REPOSITORY_DISCONNECTED: 'repository.disconnected',
  REPOSITORY_SYNCED: 'repository.synced',
  REPOSITORY_SYNC_FAILED: 'repository.sync.failed',

  // CI/CD (Phase 2A)
  PIPELINE_RUN_RECEIVED: 'pipeline.run.received',
  PIPELINE_RUN_COMPLETED: 'pipeline.run.completed',
  PIPELINE_SYNCED: 'pipeline.synced',

  // Security & Governance (Phase 3)
  SECURITY_INTEGRATION_CREATED: 'security.integration.created',
  SECURITY_INTEGRATION_ROTATED: 'security.integration.rotated',
  SECURITY_INTEGRATION_DELETED: 'security.integration.deleted',
  SECURITY_SCAN_INGESTED: 'security.scan.ingested',
  SECURITY_SCAN_COMPLETED: 'security.scan.completed',
  SECURITY_SCAN_FAILED: 'security.scan.failed',
  SECURITY_FINDING_STATUS_CHANGED: 'security.finding.status.changed',
  GOVERNANCE_POLICY_CREATED: 'governance.policy.created',
  GOVERNANCE_POLICY_UPDATED: 'governance.policy.updated',
  GOVERNANCE_POLICY_DELETED: 'governance.policy.deleted',
  POLICY_GATE_EVALUATED: 'policy.gate.evaluated',
  POLICY_GATE_OVERRIDDEN: 'policy.gate.overridden',
};

export const ENTITY_TYPES = {
  USER: 'user',
  PROJECT: 'project',
  ISSUE: 'issue',
  COMMENT: 'comment',
  REPOSITORY: 'repository',
  PIPELINE: 'pipeline',
  PIPELINE_RUN: 'pipeline_run',
  SECURITY_INTEGRATION: 'security_integration',
  SECURITY_SCAN: 'security_scan',
  SECURITY_FINDING: 'security_finding',
  GOVERNANCE_POLICY: 'governance_policy',
  POLICY_GATE_RESULT: 'policy_gate_result',
};

// Issue counter starts at 100 so first issue is PROJECT-101
export const INITIAL_ISSUE_COUNTER = 100;

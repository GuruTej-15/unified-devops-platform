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
};

export const ENTITY_TYPES = {
  USER: 'user',
  PROJECT: 'project',
  ISSUE: 'issue',
  COMMENT: 'comment',
  REPOSITORY: 'repository',
  PIPELINE: 'pipeline',
  PIPELINE_RUN: 'pipeline_run',
};

// Issue counter starts at 100 so first issue is PROJECT-101
export const INITIAL_ISSUE_COUNTER = 100;

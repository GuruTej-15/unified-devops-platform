import AuditLog from './audit.model.js';
import eventBus from '../notifications/eventBus.js';
import logger from '../../shared/logger.js';

export default class AuditService {
  static async log({ action, actor, entityType, entityId, projectId, metadata, ipAddress }) {
    try {
      return await AuditLog.create({
        action,
        actor,
        entityType,
        entityId,
        projectId,
        metadata,
        ipAddress,
      });
    } catch (err) {
      // Audit logging should never crash the application
      logger.error('Audit log write failed:', err.message);
    }
  }

  static async listAuditLogs({ page = 1, limit = 20, action, entityType, actor }) {
    const query = {};
    if (action) query.action = action;
    if (entityType) query.entityType = entityType;
    if (actor) query.actor = actor;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      AuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('actor', 'firstName lastName email'),
      AuditLog.countDocuments(query),
    ]);

    return { data, total, page, limit };
  }

  static async listProjectAuditLogs(projectId, { page = 1, limit = 20 }) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      AuditLog.find({ projectId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('actor', 'firstName lastName email'),
      AuditLog.countDocuments({ projectId }),
    ]);

    return { data, total, page, limit };
  }

  static setupEventListeners() {
    eventBus.on('user.registered', (user) => {
      AuditService.log({
        action: 'user.registered',
        actor: user._id,
        entityType: 'user',
        entityId: user._id,
      });
    });

    eventBus.on('user.login', (user) => {
      AuditService.log({
        action: 'user.login',
        actor: user._id,
        entityType: 'user',
        entityId: user._id,
      });
    });

    eventBus.on('project.created', ({ project, actor }) => {
      AuditService.log({
        action: 'project.created',
        actor,
        entityType: 'project',
        entityId: project._id,
        projectId: project._id,
      });
    });

    eventBus.on('project.updated', ({ project }) => {
      AuditService.log({
        action: 'project.updated',
        entityType: 'project',
        entityId: project._id,
        projectId: project._id,
      });
    });

    eventBus.on('project.member.added', ({ project, member }) => {
      AuditService.log({
        action: 'project.member.added',
        entityType: 'user',
        entityId: member.user,
        projectId: project,
      });
    });

    eventBus.on('issue.created', ({ issue, actor, project }) => {
      AuditService.log({
        action: 'issue.created',
        actor,
        entityType: 'issue',
        entityId: issue._id,
        projectId: project,
        metadata: { issueKey: issue.issueKey },
      });
    });

    eventBus.on('issue.updated', ({ issue, actor, project, changes }) => {
      AuditService.log({
        action: 'issue.updated',
        actor,
        entityType: 'issue',
        entityId: issue._id,
        projectId: project,
        metadata: { issueKey: issue.issueKey, changes },
      });
    });

    eventBus.on('issue.status.changed', ({ issue, actor, project, oldStatus, newStatus }) => {
      AuditService.log({
        action: 'issue.status.changed',
        actor,
        entityType: 'issue',
        entityId: issue._id,
        projectId: project,
        metadata: { issueKey: issue.issueKey, oldStatus, newStatus },
      });
    });

    eventBus.on('issue.commented', ({ issue, comment, actor, project }) => {
      AuditService.log({
        action: 'issue.commented',
        actor,
        entityType: 'comment',
        entityId: comment._id,
        projectId: project,
        metadata: { issueKey: issue.issueKey },
      });
    });

    eventBus.on('repository.connected', ({ repository, actor }) => {
      AuditService.log({
        action: 'repository.connected',
        actor,
        entityType: 'repository',
        entityId: repository._id,
        projectId: repository.project,
      });
    });

    eventBus.on('repository.synced', ({ repository, stats }) => {
      AuditService.log({
        action: 'repository.synced',
        entityType: 'repository',
        entityId: repository._id,
        projectId: repository.project,
        metadata: stats,
      });
    });

    eventBus.on('repository.sync.failed', ({ repository, error }) => {
      AuditService.log({
        action: 'repository.sync.failed',
        entityType: 'repository',
        entityId: repository._id,
        projectId: repository.project,
        metadata: { error },
      });
    });

    eventBus.on('pipeline.run.received', ({ pipelineRun, project }) => {
      AuditService.log({
        action: 'pipeline.run.received',
        entityType: 'pipeline_run',
        entityId: pipelineRun._id,
        projectId: project || pipelineRun.project,
        metadata: {
          runNumber: pipelineRun.runNumber,
          workflowName: pipelineRun.workflowName,
          status: pipelineRun.status,
          commitSha: pipelineRun.commitSha?.substring(0, 7),
        },
      });
    });

    eventBus.on('pipeline.run.completed', ({ pipelineRun, project }) => {
      AuditService.log({
        action: 'pipeline.run.completed',
        entityType: 'pipeline_run',
        entityId: pipelineRun._id,
        projectId: project || pipelineRun.project,
        metadata: {
          runNumber: pipelineRun.runNumber,
          conclusion: pipelineRun.conclusion,
          duration: pipelineRun.duration,
        },
      });
    });

    eventBus.on('pipeline.synced', ({ project, repository, actor, stats }) => {
      AuditService.log({
        action: 'pipeline.synced',
        actor,
        entityType: 'pipeline',
        entityId: repository._id,
        projectId: project,
        metadata: stats,
      });
    });

    logger.info('Audit event listeners initialized');
  }
}

// Wire up event listeners at module load
AuditService.setupEventListeners();

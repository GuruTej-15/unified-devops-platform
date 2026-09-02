import Pipeline from './pipeline.model.js';
import PipelineRun from './pipelineRun.model.js';
import Repository from '../vcs/repository.model.js';
import Project from '../projects/project.model.js';
import GitHubActionsClient from './github-actions.client.js';
import WebhookService from './webhook.service.js';
import { decrypt } from '../../shared/crypto.js';
import { NotFoundError } from '../../shared/errors.js';
import { getPaginationParams } from '../../shared/pagination.js';
import eventBus from '../notifications/eventBus.js';

export default class CicdService {
  /**
   * List pipeline runs for a project.
   */
  static async listProjectPipelineRuns(projectId, filters = {}) {
    const { page, limit, skip } = getPaginationParams(filters);
    const { status, conclusion, branch, repositoryId } = filters;

    const query = { project: projectId };
    if (status) query.status = status;
    if (conclusion) query.conclusion = conclusion;
    if (branch) query.branch = branch;
    if (repositoryId) query.repository = repositoryId;

    const [pipelineRuns, total] = await Promise.all([
      PipelineRun.find(query)
        .sort({ startedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('repository', 'name fullName provider htmlUrl defaultBranch')
        .populate('pipeline', 'name path'),
      PipelineRun.countDocuments(query),
    ]);

    return { pipelineRuns, total, page, limit };
  }

  /**
   * Get a specific pipeline run by ID.
   */
  static async getPipelineRunById(projectId, runId) {
    const run = await PipelineRun.findOne({ _id: runId, project: projectId })
      .populate('repository', 'name fullName provider htmlUrl defaultBranch')
      .populate('pipeline', 'name path');
    if (!run) throw new NotFoundError('Pipeline run not found');
    return run;
  }

  /**
   * List pipeline definitions for a project.
   */
  static async listProjectPipelines(projectId) {
    return Pipeline.find({ project: projectId })
      .sort({ name: 1 })
      .populate('repository', 'name fullName defaultBranch');
  }

  /**
   * Get pipeline runs associated with an issue key.
   */
  static async getIssuePipelineRuns(projectId, issueKey) {
    return PipelineRun.find({
      project: projectId,
      matchedIssueKeys: issueKey,
    })
      .sort({ startedAt: -1, createdAt: -1 })
      .populate('repository', 'name fullName defaultBranch htmlUrl');
  }

  /**
   * Manually reconcile / pull latest workflow runs from GitHub Actions.
   * Safe fallback for when webhooks were missed or during initial sync.
   */
  static async reconcileRepositoryRuns(repoId, userId) {
    const repo = await Repository.findById(repoId).select('+encryptedToken +tokenIv +tokenAuthTag');
    if (!repo) throw new NotFoundError('Repository not found');

    const project = await Project.findById(repo.project);
    if (!project) throw new NotFoundError('Project not found');

    const token = decrypt({
      ciphertext: repo.encryptedToken,
      iv: repo.tokenIv,
      authTag: repo.tokenAuthTag,
    });

    const client = new GitHubActionsClient(token);
    const runs = await client.getWorkflowRuns(repo.owner, repo.name, { limit: 30 });

    const stats = { runsSynced: 0, runsCreated: 0, runsUpdated: 0 };

    for (const run of runs) {
      // Find or create pipeline definition
      const pipeline = await Pipeline.findOneAndUpdate(
        {
          repository: repo._id,
          externalWorkflowId: String(run.workflow_id),
        },
        {
          project: project._id,
          repository: repo._id,
          provider: 'github_actions',
          externalWorkflowId: String(run.workflow_id),
          name: run.name || 'CI Workflow',
          path: run.path || '',
          status: 'active',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Multi-step issue traceability
      const textSources = [run.head_commit?.message || '', run.head_branch || ''];
      if (Array.isArray(run.pull_requests)) {
        for (const pr of run.pull_requests) {
          if (pr.head?.ref) textSources.push(pr.head.ref);
        }
      }
      const combinedText = textSources.join(' ');
      const candidateKeys = await WebhookService._validateIssueKeys(
        combinedText.match(/[A-Z]{2,10}-\d+/g) || [],
        project
      );

      let duration = null;
      if (run.run_started_at && run.updated_at && run.status === 'completed') {
        const start = new Date(run.run_started_at).getTime();
        const end = new Date(run.updated_at).getTime();
        if (!isNaN(start) && !isNaN(end) && end >= start) {
          duration = Math.round((end - start) / 1000);
        }
      }

      const runData = {
        project: project._id,
        repository: repo._id,
        pipeline: pipeline._id,
        provider: 'github_actions',
        providerEvent: 'reconcile_api',
        providerAction: run.status,
        webhookDeliveryId: '',
        webhookReceivedAt: new Date(),
        externalRunId: String(run.id),
        runNumber: run.run_number || 1,
        workflowName: run.name || pipeline.name,
        workflowPath: run.path || pipeline.path,
        commitSha: run.head_sha || '',
        branch: run.head_branch || '',
        pullRequestNumber: run.pull_requests?.[0]?.number || null,
        matchedIssueKeys: candidateKeys,
        eventType: run.event || 'push',
        status: run.status || 'queued',
        conclusion: run.conclusion || null,
        htmlUrl: run.html_url || '',
        startedAt: run.run_started_at ? new Date(run.run_started_at) : new Date(),
        completedAt: run.status === 'completed' && run.updated_at ? new Date(run.updated_at) : null,
        duration,
        actor: run.actor,
        headCommitMessage: run.head_commit?.message || '',
      };

      const result = await PipelineRun.findOneAndUpdate(
        { repository: repo._id, externalRunId: String(run.id) },
        runData,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      stats.runsSynced++;
      if (result.createdAt.getTime() === result.updatedAt.getTime()) {
        stats.runsCreated++;
      } else {
        stats.runsUpdated++;
      }
    }

    eventBus.emit('pipeline.synced', {
      repository: repo,
      project: project._id,
      actor: userId,
      stats,
    });

    return stats;
  }
}

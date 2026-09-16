import Repository from '../vcs/repository.model.js';
import Project from '../projects/project.model.js';
import Pipeline from './pipeline.model.js';
import PipelineRun from './pipelineRun.model.js';
import PullRequest from '../vcs/pullRequest.model.js';
import GitHubActionsClient from './github-actions.client.js';
import WebhookService from './webhook.service.js';
import { decrypt } from '../../shared/crypto.js';
import { NotFoundError } from '../../shared/errors.js';
import eventBus from '../notifications/eventBus.js';
import JenkinsIntegration from './jenkinsIntegration.model.js';
import JenkinsClient from './providers/jenkinsClient.js';
import { getCiProvider } from './providers/providerRegistry.js';
import { CI_PROVIDER } from '../../shared/constants.js';
import { publishPipelineEvent } from './events/ciEventBridge.js';
import { extractIssueKeys } from '../../shared/issueKeyParser.js';
import logger from '../../shared/logger.js';

export default class ReconciliationService {
  /**
   * Reconcile a single repository against GitHub Actions REST API.
   */
  static async reconcileRepository(repoId, { lookbackMinutes = 60, actorId = null } = {}) {
    const repo = await Repository.findById(repoId).select('+encryptedToken +tokenIv +tokenAuthTag');
    if (!repo) throw new NotFoundError(`Repository ${repoId} not found`);

    const project = await Project.findById(repo.project);
    if (!project) throw new NotFoundError(`Project for repository ${repoId} not found`);

    const token = decrypt({
      ciphertext: repo.encryptedToken,
      iv: repo.tokenIv,
      authTag: repo.tokenAuthTag,
    });

    const client = new GitHubActionsClient(token);
    const runs = await client.getWorkflowRuns(repo.owner, repo.name, { limit: 30 });

    const cutoffTime = lookbackMinutes ? Date.now() - lookbackMinutes * 60 * 1000 : 0;
    const stats = { runsSynced: 0, runsCreated: 0, runsUpdated: 0 };

    for (const run of runs) {
      const runTime = new Date(run.updated_at || run.run_started_at).getTime();
      if (cutoffTime && runTime < cutoffTime) {
        continue; // Skip runs older than lookback window
      }

      // 1. Upsert Pipeline Workflow definition
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

      // 2. Issue Traceability
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

      // 3. Duration calculation
      let duration = null;
      if (run.run_started_at && run.updated_at && run.status === 'completed') {
        const start = new Date(run.run_started_at).getTime();
        const end = new Date(run.updated_at).getTime();
        if (!isNaN(start) && !isNaN(end) && end >= start) {
          duration = Math.round((end - start) / 1000);
        }
      }

      // 4. Find Associated PR
      let associatedPr = null;
      const prNumber = run.pull_requests?.[0]?.number || null;
      if (prNumber) {
        associatedPr = await PullRequest.findOne({
          repository: repo._id,
          number: prNumber,
        });
      }

      // 5. Build run record
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
        pullRequestNumber: prNumber,
        pullRequest: associatedPr?._id || null,
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

      // 6. Idempotent upsert with status protection
      const result = await PipelineRun.upsertWithStatusGuard(
        {
          repository: repo._id,
          provider: 'github_actions',
          jenkinsIntegration: null,
          externalRunId: String(run.id),
        },
        runData
      );

      stats.runsSynced++;
      if (result.createdAt.getTime() === result.updatedAt.getTime()) {
        stats.runsCreated++;
      } else {
        stats.runsUpdated++;
      }
    }

    // 7. Emit reconciliation domain event
    eventBus.emit('pipeline.synced', {
      repository: repo,
      project: project._id,
      actor: actorId,
      stats,
    });

    // Only emit and publish cross-process pipeline.updated when runs were created or updated
    if (stats.runsCreated > 0 || stats.runsUpdated > 0) {
      await publishPipelineEvent('pipeline.updated', {
        project: project._id,
        repository: repo,
        stats,
      });
    }

    logger.info(
      `Reconciled repository ${repo.fullName}: ${stats.runsSynced} synced (${stats.runsCreated} created, ${stats.runsUpdated} updated)`
    );

    return stats;
  }

  /**
   * Reconcile a single Jenkins integration against the Jenkins REST API.
   */
  static async reconcileJenkinsIntegration(
    integrationId,
    { lookbackMinutes = 60, actorId: _actorId = null } = {}
  ) {
    const integration = await JenkinsIntegration.findById(integrationId).select(
      '+encryptedApiToken +apiTokenIv +apiTokenAuthTag'
    );
    if (!integration || !integration.isActive) {
      return { runsSynced: 0, runsCreated: 0, runsUpdated: 0 };
    }

    const project = await Project.findById(integration.project);
    const repo = await Repository.findById(integration.repository);
    if (!project || !repo) {
      return { runsSynced: 0, runsCreated: 0, runsUpdated: 0 };
    }

    let apiToken = '';
    if (integration.encryptedApiToken) {
      try {
        apiToken = decrypt({
          ciphertext: integration.encryptedApiToken,
          iv: integration.apiTokenIv,
          authTag: integration.apiTokenAuthTag,
        });
      } catch (err) {
        logger.warn(
          `Failed to decrypt Jenkins API token for integration ${integrationId}: ${err.message}`
        );
      }
    }

    const client = new JenkinsClient({
      serverUrl: integration.serverUrl,
      username: integration.username,
      apiToken,
    });

    const builds = await client.getBuildRuns(integration.jobName, { limit: 30 });
    const cutoffTime = lookbackMinutes ? Date.now() - lookbackMinutes * 60 * 1000 : 0;
    const stats = { runsSynced: 0, runsCreated: 0, runsUpdated: 0 };
    const jenkinsProvider = getCiProvider(CI_PROVIDER.JENKINS);

    for (const build of builds) {
      const buildTime = build.timestamp ? new Date(build.timestamp).getTime() : 0;
      if (cutoffTime && buildTime && buildTime < cutoffTime) {
        continue;
      }

      const normalized = await jenkinsProvider.normalizeWebhookPayload(
        { build, name: integration.jobName },
        { event: 'reconcile_api', integrationId: integration._id },
        { integration, repository: repo, project }
      );

      const pipeline = await Pipeline.findOneAndUpdate(
        {
          repository: repo._id,
          externalWorkflowId: normalized.externalWorkflowId,
        },
        {
          project: project._id,
          repository: repo._id,
          provider: 'jenkins',
          externalWorkflowId: normalized.externalWorkflowId,
          name: normalized.workflowName,
          path: 'Jenkinsfile',
          status: 'active',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      const combinedText = (normalized.textForIssueKeyExtraction || []).join(' ');
      const candidateKeys = extractIssueKeys(combinedText);
      const matchedIssueKeys = await WebhookService._validateIssueKeys(candidateKeys, project);

      const runData = {
        project: project._id,
        repository: repo._id,
        pipeline: pipeline._id,
        provider: 'jenkins',
        jenkinsIntegration: integration._id,
        providerEvent: 'reconcile_api',
        providerAction: normalized.providerAction || '',
        webhookDeliveryId: '',
        webhookReceivedAt: new Date(),
        externalRunId: normalized.externalRunId,
        runNumber: normalized.runNumber,
        workflowName: normalized.workflowName,
        workflowPath: 'Jenkinsfile',
        commitSha: normalized.commitSha || '',
        branch: normalized.branch || '',
        pullRequestNumber: null,
        pullRequest: null,
        matchedIssueKeys,
        eventType: 'reconcile',
        status: normalized.status,
        conclusion: normalized.conclusion,
        htmlUrl: normalized.htmlUrl || '',
        startedAt: normalized.startedAt || new Date(),
        completedAt: normalized.completedAt || null,
        duration: normalized.duration,
        actor: normalized.actor || { login: 'jenkins', avatarUrl: '' },
        headCommitMessage: normalized.headCommitMessage || '',
      };

      const filter = {
        repository: repo._id,
        provider: 'jenkins',
        jenkinsIntegration: integration._id,
        externalRunId: normalized.externalRunId,
      };

      const result = await PipelineRun.upsertWithStatusGuard(filter, runData);
      stats.runsSynced++;
      if (result.createdAt.getTime() === result.updatedAt.getTime()) {
        stats.runsCreated++;
      } else {
        stats.runsUpdated++;
      }
    }

    if (stats.runsCreated > 0 || stats.runsUpdated > 0) {
      await publishPipelineEvent('pipeline.updated', {
        project: project._id,
        repository: repo,
        stats,
      });
    }

    await JenkinsIntegration.findByIdAndUpdate(integration._id, { lastSyncedAt: new Date() });
    return stats;
  }

  /**
   * Reconcile all connected repositories and Jenkins integrations for a project.
   */
  static async reconcileProject(projectId, { lookbackMinutes = 60, actorId = null } = {}) {
    const repos = await Repository.find({ project: projectId });
    const jenkinsIntegrations = await JenkinsIntegration.find({
      project: projectId,
      isActive: true,
    });
    const aggregateStats = {
      reposProcessed: 0,
      integrationsProcessed: 0,
      runsSynced: 0,
      runsCreated: 0,
      runsUpdated: 0,
    };

    // 1. Reconcile GitHub repositories
    for (const repo of repos) {
      try {
        const stats = await this.reconcileRepository(repo._id, { lookbackMinutes, actorId });
        aggregateStats.reposProcessed++;
        aggregateStats.runsSynced += stats.runsSynced;
        aggregateStats.runsCreated += stats.runsCreated;
        aggregateStats.runsUpdated += stats.runsUpdated;
      } catch (err) {
        logger.error(`Error reconciling repo ${repo.fullName}: ${err.message}`);
      }
    }

    // 2. Reconcile Jenkins integrations
    for (const integration of jenkinsIntegrations) {
      try {
        const stats = await this.reconcileJenkinsIntegration(integration._id, {
          lookbackMinutes,
          actorId,
        });
        aggregateStats.integrationsProcessed++;
        aggregateStats.runsSynced += stats.runsSynced;
        aggregateStats.runsCreated += stats.runsCreated;
        aggregateStats.runsUpdated += stats.runsUpdated;
      } catch (err) {
        logger.error(`Error reconciling Jenkins job ${integration.jobName}: ${err.message}`);
      }
    }

    return aggregateStats;
  }

  /**
   * Reconcile all connected repositories across all projects (scheduled cron).
   */
  static async reconcileAllConnectedRepositories({ lookbackMinutes = 60 } = {}) {
    const repos = await Repository.find({});
    const jenkinsIntegrations = await JenkinsIntegration.find({ isActive: true });
    logger.info(
      `Starting scheduled CI reconciliation across ${repos.length} repos and ${jenkinsIntegrations.length} Jenkins jobs`
    );

    let totalSynced = 0;
    for (const repo of repos) {
      try {
        const stats = await this.reconcileRepository(repo._id, { lookbackMinutes });
        totalSynced += stats.runsSynced;
      } catch (err) {
        logger.warn(`Scheduled reconciliation skipped for ${repo.fullName}: ${err.message}`);
      }
    }

    for (const integration of jenkinsIntegrations) {
      try {
        const stats = await this.reconcileJenkinsIntegration(integration._id, { lookbackMinutes });
        totalSynced += stats.runsSynced;
      } catch (err) {
        logger.warn(
          `Scheduled reconciliation skipped for Jenkins job ${integration.jobName}: ${err.message}`
        );
      }
    }

    logger.info(
      `Completed scheduled CI reconciliation: ${totalSynced} runs processed across ${repos.length} repos and ${jenkinsIntegrations.length} Jenkins jobs`
    );
    return { totalRepos: repos.length, totalJenkinsJobs: jenkinsIntegrations.length, totalSynced };
  }
}

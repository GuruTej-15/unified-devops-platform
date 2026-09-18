import { Worker, UnrecoverableError } from 'bullmq';
import config from '../../../config/index.js';
import { createRedisConnection } from '../../../config/redis.js';
import Repository from '../../vcs/repository.model.js';
import Project from '../../projects/project.model.js';
import Pipeline from '../pipeline.model.js';
import PipelineRun from '../pipelineRun.model.js';
import PullRequest from '../../vcs/pullRequest.model.js';
import WebhookDelivery from '../webhookDelivery.model.js';
import WebhookService from '../webhook.service.js';
import ReconciliationService from '../reconciliation.service.js';
import { extractIssueKeys } from '../../../shared/issueKeyParser.js';
import { publishPipelineEvent } from '../events/ciEventBridge.js';
import JenkinsIntegration from '../jenkinsIntegration.model.js';
import JenkinsClient from '../providers/jenkinsClient.js';
import { getCiProvider } from '../providers/providerRegistry.js';
import { decrypt } from '../../../shared/crypto.js';
import { CI_PROVIDER } from '../../../shared/constants.js';
import { processSecurityScanJob } from '../../security/securityScanProcessor.js';
import logger from '../../../shared/logger.js';

/**
 * Worker handler to process an individual CI webhook job.
 */
export async function processWebhookJob({
  provider: jobProvider,
  deliveryId,
  integrationId,
  event,
  payload,
}) {
  const providerName = jobProvider || 'github_actions';
  const providerAdapter = getCiProvider(providerName);

  if (providerName === 'github_actions' && event !== 'workflow_run') {
    logger.info(`Worker skipping unhandled event type '${event}' for delivery ${deliveryId}`);
    await WebhookDelivery.findOneAndUpdate(
      { deliveryId },
      { status: 'ignored', processedAt: new Date() }
    );
    return { ignored: true, reason: `Unhandled event '${event}'` };
  }

  if (!payload || typeof payload !== 'object') {
    await WebhookDelivery.findOneAndUpdate(
      { deliveryId },
      {
        status: 'failed',
        errorMessage: 'Malformed webhook payload',
        processedAt: new Date(),
      }
    );
    throw new UnrecoverableError('Malformed webhook payload');
  }

  try {
    let integration = null;
    let repository = null;
    let project = null;

    if (providerName === CI_PROVIDER.JENKINS) {
      if (integrationId) {
        integration = await JenkinsIntegration.findById(integrationId).select(
          '+encryptedApiToken +apiTokenIv +apiTokenAuthTag'
        );
      }
      if (!integration) {
        logger.warn(
          `Worker: Jenkins integration ${integrationId} not found for delivery ${deliveryId}`
        );
        await WebhookDelivery.findOneAndUpdate(
          { deliveryId },
          {
            status: 'ignored',
            errorMessage: 'Jenkins integration not found',
            processedAt: new Date(),
          }
        );
        return { ignored: true, reason: 'Jenkins integration not found' };
      }
      repository = await Repository.findById(integration.repository);
      project = await Project.findById(integration.project);
    } else {
      // Default / GitHub Actions
      const repoExternalId = String(payload.repository?.id || '');
      repository = await Repository.findOne({ externalId: repoExternalId });
      if (!repository) {
        logger.info(
          `Worker: Repository ${payload.repository?.full_name} (ID: ${payload.repository?.id}) not connected. Ignoring.`
        );
        await WebhookDelivery.findOneAndUpdate(
          { deliveryId },
          { status: 'ignored', errorMessage: 'Repository not connected', processedAt: new Date() }
        );
        return { ignored: true, reason: 'Repository not connected' };
      }
      project = await Project.findById(repository.project);
    }

    if (!project || !repository) {
      logger.warn(`Worker: Associated project or repository not found for delivery ${deliveryId}`);
      await WebhookDelivery.findOneAndUpdate(
        { deliveryId },
        {
          status: 'ignored',
          errorMessage: 'Project or repository not found',
          processedAt: new Date(),
        }
      );
      return { ignored: true, reason: 'Project or repository not found' };
    }

    // 1. Normalize webhook payload via provider adapter
    const normalized = await providerAdapter.normalizeWebhookPayload(
      payload,
      { deliveryId, event, integrationId },
      { integration, repository, project }
    );

    // 2. Optional REST enrichment for Jenkins if commitSha or duration is missing and API token available
    if (
      providerName === CI_PROVIDER.JENKINS &&
      integration &&
      integration.username &&
      integration.encryptedApiToken &&
      (!normalized.commitSha || normalized.duration == null)
    ) {
      try {
        const apiToken = decrypt({
          ciphertext: integration.encryptedApiToken,
          iv: integration.apiTokenIv,
          authTag: integration.apiTokenAuthTag,
        });
        const client = new JenkinsClient({
          serverUrl: integration.serverUrl,
          username: integration.username,
          apiToken,
        });
        const details = await client.getBuildDetails(integration.jobName, normalized.runNumber);
        if (!normalized.commitSha && details.changeSets) {
          for (const cs of details.changeSets) {
            if (cs.items?.[0]?.commitId) {
              normalized.commitSha = cs.items[0].commitId;
              break;
            }
          }
        }
        if (
          normalized.duration == null &&
          typeof details.duration === 'number' &&
          details.duration > 0
        ) {
          normalized.duration = Math.round(
            details.duration > 1000 ? details.duration / 1000 : details.duration
          );
        }
      } catch (enrichErr) {
        logger.debug(`Worker: Jenkins REST enrichment skipped: ${enrichErr.message}`);
      }
    }

    // 3. Upsert Pipeline Workflow definition
    const pipeline = await Pipeline.findOneAndUpdate(
      {
        repository: repository._id,
        externalWorkflowId: normalized.externalWorkflowId,
      },
      {
        project: project._id,
        repository: repository._id,
        provider: providerName,
        externalWorkflowId: normalized.externalWorkflowId,
        name: normalized.workflowName,
        path: normalized.workflowPath || '',
        status: 'active',
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 4. Multi-step Issue Traceability Extraction
    const combinedText = (normalized.textForIssueKeyExtraction || []).join(' ');
    const candidateKeys = extractIssueKeys(combinedText);
    const matchedIssueKeys = await WebhookService._validateIssueKeys(candidateKeys, project);

    // 5. Resolve Associated PR if number present
    let associatedPr = null;
    if (normalized.pullRequestNumber) {
      associatedPr = await PullRequest.findOne({
        repository: repository._id,
        number: normalized.pullRequestNumber,
      });
    }

    // 6. Build normalized PipelineRun data
    const runData = {
      project: project._id,
      repository: repository._id,
      pipeline: pipeline._id,
      provider: providerName,
      jenkinsIntegration: normalized.jenkinsIntegration || null,
      providerEvent: normalized.providerEvent || event,
      providerAction: normalized.providerAction || '',
      webhookDeliveryId: deliveryId || '',
      webhookReceivedAt: new Date(),
      externalRunId: normalized.externalRunId,
      runNumber: normalized.runNumber,
      workflowName: normalized.workflowName,
      workflowPath: normalized.workflowPath || '',
      commitSha: normalized.commitSha || '',
      branch: normalized.branch || '',
      pullRequestNumber: normalized.pullRequestNumber || null,
      pullRequest: associatedPr?._id || null,
      matchedIssueKeys,
      eventType: normalized.eventType || 'push',
      status: normalized.status,
      conclusion: normalized.conclusion,
      htmlUrl: normalized.htmlUrl || '',
      startedAt: normalized.startedAt || new Date(),
      completedAt: normalized.completedAt || null,
      duration: normalized.duration,
      actor: normalized.actor || { login: providerName, avatarUrl: '' },
      headCommitMessage: normalized.headCommitMessage || '',
    };

    // 7. Atomic Idempotent Upsert with Status Protection Guard
    const filter = {
      repository: repository._id,
      provider: providerName,
      jenkinsIntegration: normalized.jenkinsIntegration || null,
      externalRunId: normalized.externalRunId,
    };

    const pipelineRun = await PipelineRun.upsertWithStatusGuard(filter, runData);

    // 8. Mark WebhookDelivery as processed
    await WebhookDelivery.findOneAndUpdate(
      { deliveryId },
      {
        status: 'processed',
        provider: providerName,
        jenkinsIntegration: normalized.jenkinsIntegration || null,
        repository: repository._id,
        project: project._id,
        processedAt: new Date(),
      }
    );

    // 9. Emit domain events across processes via Redis Pub/Sub bridge
    await publishPipelineEvent('pipeline.run.received', {
      pipelineRun,
      project: project._id,
      repository: repository._id,
    });

    if (pipelineRun.status === 'completed') {
      await publishPipelineEvent('pipeline.run.completed', {
        pipelineRun,
        project: project._id,
        repository: repository._id,
      });
    }

    await publishPipelineEvent('pipeline.updated', {
      pipelineRun,
      project: project._id,
    });

    logger.info(
      `Worker processed PipelineRun #${pipelineRun.runNumber} (${pipelineRun.workflowName}, provider: ${pipelineRun.provider}, status: ${pipelineRun.status}, conclusion: ${pipelineRun.conclusion}) for delivery ${deliveryId}`
    );

    return {
      success: true,
      runId: pipelineRun._id,
      externalRunId: pipelineRun.externalRunId,
      status: pipelineRun.status,
      conclusion: pipelineRun.conclusion,
    };
  } catch (err) {
    logger.error(`Worker error processing webhook ${deliveryId}: ${err.message}`);
    await WebhookDelivery.findOneAndUpdate(
      { deliveryId },
      { status: 'failed', errorMessage: err.message, processedAt: new Date() }
    );
    throw err;
  }
}

/**
 * Worker handler to process reconciliation jobs.
 */
export async function processReconciliationJob(data) {
  const { projectId, repositoryId, lookbackMinutes, actorId } = data;

  if (repositoryId) {
    return ReconciliationService.reconcileRepository(repositoryId, {
      lookbackMinutes,
      actorId,
    });
  }

  if (projectId) {
    return ReconciliationService.reconcileProject(projectId, {
      lookbackMinutes,
      actorId,
    });
  }

  return ReconciliationService.reconcileAllConnectedRepositories({
    lookbackMinutes,
  });
}

/**
 * Initialize and start the BullMQ worker.
 * Must be executed only by worker process entrypoint, NOT server.js.
 */
export function initCiWorker() {
  logger.info(
    `Starting CI Worker on queue '${config.cicd.queueName}' (concurrency: ${config.cicd.workerConcurrency})`
  );

  const connection = createRedisConnection();

  const worker = new Worker(
    config.cicd.queueName,
    async (job) => {
      logger.info(`Worker picked up job #${job.id} (name: ${job.name})`);

      if (job.name === 'webhook_event') {
        return processWebhookJob(job.data);
      }

      if (job.name === 'reconcile_repository' || job.name === 'reconcile_all_scheduled') {
        return processReconciliationJob(job.data);
      }

      if (job.name === 'security_scan_ingest') {
        return processSecurityScanJob(job.data);
      }

      throw new UnrecoverableError(`Unknown job name '${job.name}'`);
    },
    {
      connection,
      concurrency: config.cicd.workerConcurrency,
    }
  );

  worker.on('completed', (job) => {
    logger.info(`Job #${job.id} completed successfully`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Job #${job?.id} FAILED after ${job?.attemptsMade} attempt(s): ${err.message}`, {
      jobId: job?.id,
      deliveryId: job?.data?.deliveryId,
      eventName: job?.name,
      failedReason: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.warn(`Worker connection error: ${err.message}`);
  });

  return worker;
}

export default {
  processWebhookJob,
  processReconciliationJob,
  processSecurityScanJob,
  initCiWorker,
};

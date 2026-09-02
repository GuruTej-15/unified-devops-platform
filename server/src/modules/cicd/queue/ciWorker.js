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
import eventBus from '../../notifications/eventBus.js';
import logger from '../../../shared/logger.js';

/**
 * Worker handler to process an individual CI webhook job.
 */
export async function processWebhookJob({ deliveryId, event, payload }) {
  if (event !== 'workflow_run') {
    logger.info(`Worker skipping unhandled event type '${event}' for delivery ${deliveryId}`);
    await WebhookDelivery.findOneAndUpdate(
      { deliveryId },
      { status: 'ignored', processedAt: new Date() }
    );
    return { ignored: true, reason: `Unhandled event '${event}'` };
  }

  const { workflow_run: run, repository: repoPayload, action } = payload;
  if (!run || !repoPayload) {
    await WebhookDelivery.findOneAndUpdate(
      { deliveryId },
      {
        status: 'failed',
        errorMessage: 'Malformed workflow_run webhook payload',
        processedAt: new Date(),
      }
    );
    throw new UnrecoverableError('Malformed workflow_run webhook payload');
  }

  try {
    // 1. Resolve Platform Repository
    const repository = await Repository.findOne({ externalId: String(repoPayload.id) });
    if (!repository) {
      logger.info(
        `Worker: Repository ${repoPayload.full_name} (ID: ${repoPayload.id}) not connected. Ignoring.`
      );
      await WebhookDelivery.findOneAndUpdate(
        { deliveryId },
        { status: 'ignored', errorMessage: 'Repository not connected', processedAt: new Date() }
      );
      return { ignored: true, reason: 'Repository not connected' };
    }

    // 2. Resolve Project
    const project = await Project.findById(repository.project);
    if (!project) {
      logger.warn(`Worker: Associated project not found for repository ID ${repository._id}`);
      await WebhookDelivery.findOneAndUpdate(
        { deliveryId },
        { status: 'ignored', errorMessage: 'Associated project not found', processedAt: new Date() }
      );
      return { ignored: true, reason: 'Project not found' };
    }

    // 3. Find or create Pipeline definition
    const pipeline = await Pipeline.findOneAndUpdate(
      {
        repository: repository._id,
        externalWorkflowId: String(run.workflow_id),
      },
      {
        project: project._id,
        repository: repository._id,
        provider: 'github_actions',
        externalWorkflowId: String(run.workflow_id),
        name: run.name || 'CI Workflow',
        path: run.path || '',
        status: 'active',
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 4. Multi-step Issue Traceability Extraction
    const textSources = [run.head_commit?.message || '', run.head_branch || ''];
    if (Array.isArray(run.pull_requests)) {
      for (const pr of run.pull_requests) {
        if (pr.head?.ref) textSources.push(pr.head.ref);
        if (pr.title) textSources.push(pr.title);
      }
    }
    const combinedText = textSources.join(' ');
    const candidateKeys = extractIssueKeys(combinedText);
    const matchedIssueKeys = await WebhookService._validateIssueKeys(candidateKeys, project);

    // 5. Calculate Duration
    let duration = null;
    if (run.run_started_at && run.updated_at && run.status === 'completed') {
      const start = new Date(run.run_started_at).getTime();
      const end = new Date(run.updated_at).getTime();
      if (!isNaN(start) && !isNaN(end) && end >= start) {
        duration = Math.round((end - start) / 1000);
      }
    }

    // 6. Resolve Associated PR
    let associatedPr = null;
    const prNumber = run.pull_requests?.[0]?.number || null;
    if (prNumber) {
      associatedPr = await PullRequest.findOne({
        repository: repository._id,
        number: prNumber,
      });
    }

    // 7. Atomic Idempotent Upsert with Status Protection Guard
    const runData = {
      project: project._id,
      repository: repository._id,
      pipeline: pipeline._id,
      provider: 'github_actions',
      providerEvent: event,
      providerAction: action || run.status,
      webhookDeliveryId: deliveryId || '',
      webhookReceivedAt: new Date(),
      externalRunId: String(run.id),
      runNumber: run.run_number || 1,
      workflowName: run.name || pipeline.name,
      workflowPath: run.path || pipeline.path,
      commitSha: run.head_sha || '',
      branch: run.head_branch || '',
      pullRequestNumber: prNumber,
      pullRequest: associatedPr?._id || null,
      matchedIssueKeys,
      eventType: run.event || 'push',
      status: run.status || 'queued',
      conclusion: run.conclusion || null,
      htmlUrl: run.html_url || '',
      startedAt: run.run_started_at ? new Date(run.run_started_at) : new Date(),
      completedAt: run.status === 'completed' && run.updated_at ? new Date(run.updated_at) : null,
      duration,
      actor: {
        login: run.actor?.login || 'github-actions',
        avatarUrl: run.actor?.avatar_url || '',
      },
      headCommitMessage: run.head_commit?.message || '',
    };

    const pipelineRun = await PipelineRun.upsertWithStatusGuard(
      { repository: repository._id, externalRunId: String(run.id) },
      runData
    );

    // 8. Mark WebhookDelivery as processed
    await WebhookDelivery.findOneAndUpdate(
      { deliveryId },
      {
        status: 'processed',
        repository: repository._id,
        project: project._id,
        processedAt: new Date(),
      }
    );

    // 9. Emit domain events
    eventBus.emit('pipeline.run.received', {
      pipelineRun,
      project: project._id,
      repository: repository._id,
    });

    if (pipelineRun.status === 'completed') {
      eventBus.emit('pipeline.run.completed', {
        pipelineRun,
        project: project._id,
        repository: repository._id,
      });
    }

    eventBus.emit('pipeline.updated', {
      pipelineRun,
      project: project._id,
    });

    logger.info(
      `Worker processed PipelineRun #${pipelineRun.runNumber} (${pipelineRun.workflowName}, status: ${pipelineRun.status}, conclusion: ${pipelineRun.conclusion}) for delivery ${deliveryId}`
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
  initCiWorker,
};

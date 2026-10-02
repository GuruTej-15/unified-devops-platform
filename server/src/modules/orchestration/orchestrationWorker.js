import { Worker, UnrecoverableError } from 'bullmq';
import config from '../../config/index.js';
import { createRedisConnection } from '../../config/redis.js';
import OrchestrationIntegration from './orchestrationIntegration.model.js';
import OrchestrationDelivery from './orchestrationDelivery.model.js';
import OrchestrationObservation from './orchestrationObservation.model.js';
import { getOrchestrationProvider } from './providers/orchestrationProviderRegistry.js';
import { enqueueOrchestrationJob } from './orchestrationQueue.js';
import { decrypt } from '../../shared/crypto.js';
import {
  ORCHESTRATION_PROVIDER,
  ORCHESTRATION_STATUS,
  ORCHESTRATION_DELIVERY_STATUS,
  ORCHESTRATION_HEALTH_STATUS,
  ORCHESTRATION_SYNC_STATUS,
} from '../../shared/constants.js';
import DeploymentService from '../deployment/deployment.service.js';
import logger from '../../shared/logger.js';

/**
 * Sanitizes error messages to ensure credentials, tokens, and certificates never leak.
 *
 * @param {string} message
 * @param {string} [token]
 * @returns {string}
 */
export function sanitizeErrorMessage(message, token) {
  if (!message) return 'Orchestration operation failed';
  let safe = String(message);
  if (token && typeof token === 'string' && token.length > 0) {
    safe = safe.split(token).join('[REDACTED]');
  }
  return safe;
}

/**
 * Distinguishes transient failures (which should retry with backoff)
 * from permanent failures (which should stop retrying via UnrecoverableError).
 *
 * @param {Error} err
 * @returns {boolean} True if transient, false if permanent
 */
export function isTransientError(err) {
  if (!err) return false;
  if (err instanceof UnrecoverableError) return false;

  const msg = (err.message || '').toLowerCase();

  // Permanent error signals: do not retry
  if (
    msg.includes('unsupported') ||
    msg.includes('not found') ||
    msg.includes('404') ||
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid credentials') ||
    msg.includes('token expired') ||
    msg.includes('ssrf') ||
    msg.includes('private ip') ||
    msg.includes('loopback') ||
    msg.includes('metadata') ||
    msg.includes('bad request') ||
    msg.includes('missing') ||
    msg.includes('deleted') ||
    msg.includes('malformed')
  ) {
    return false;
  }

  // Transient signals: safe to retry
  if (
    msg.includes('timed out') ||
    msg.includes('time out') ||
    msg.includes('timeout') ||
    msg.includes('abort') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('network') ||
    err.name === 'AbortError' ||
    err.name === 'TimeoutError'
  ) {
    return true;
  }

  return false;
}

/**
 * Process a single orchestration workload observation job.
 * Provider-agnostic: resolves provider via registry, fetches observation,
 * normalizes and persists authoritative OrchestrationObservation.
 *
 * @param {object} jobData
 * @param {string} jobData.integrationId
 * @param {string|null} [jobData.deliveryId]
 * @param {string} [jobData.projectId]
 * @param {string} [jobData.reason]
 * @param {string} [jobData.applicationName]
 * @param {string} [jobData.workloadType]
 * @param {string} [jobData.workloadName]
 * @param {string} [jobData.namespace]
 * @returns {Promise<object>} Processing outcome
 */
export async function processOrchestrationJob(jobData = {}) {
  const { integrationId, deliveryId, applicationName, workloadType, workloadName, namespace } =
    jobData;

  if (!integrationId) {
    throw new UnrecoverableError('Missing integrationId in orchestration job');
  }

  // 1. Transition delivery to 'processing'
  if (deliveryId) {
    await OrchestrationDelivery.findByIdAndUpdate(deliveryId, {
      status: ORCHESTRATION_DELIVERY_STATUS.PROCESSING,
    });
  }

  // 2. Load integration from MongoDB
  const integration = await OrchestrationIntegration.findById(integrationId).select(
    '+encryptedToken +tokenIv +tokenAuthTag'
  );

  if (!integration) {
    logger.warn(`Worker: Orchestration integration ${integrationId} not found`);
    if (deliveryId) {
      await OrchestrationDelivery.findByIdAndUpdate(deliveryId, {
        status: ORCHESTRATION_DELIVERY_STATUS.FAILED,
        errorMessage: 'Orchestration integration not found',
        processedAt: new Date(),
      });
    }
    throw new UnrecoverableError(`Orchestration integration ${integrationId} not found`);
  }

  // 3. Check active state
  if (integration.status === 'deleted') {
    logger.warn(`Worker: Orchestration integration ${integrationId} is deleted`);
    if (deliveryId) {
      await OrchestrationDelivery.findByIdAndUpdate(deliveryId, {
        status: ORCHESTRATION_DELIVERY_STATUS.FAILED,
        errorMessage: 'Orchestration integration is deleted',
        processedAt: new Date(),
      });
    }
    throw new UnrecoverableError(`Orchestration integration ${integrationId} is deleted`);
  }

  // 4. Resolve provider adapter through registry
  const providerAdapter = getOrchestrationProvider(integration.provider);
  if (!providerAdapter) {
    const safeMsg = `Unsupported orchestration provider: '${integration.provider}'`;
    if (deliveryId) {
      await OrchestrationDelivery.findByIdAndUpdate(deliveryId, {
        status: ORCHESTRATION_DELIVERY_STATUS.FAILED,
        errorMessage: safeMsg,
        processedAt: new Date(),
      });
    }
    throw new UnrecoverableError(safeMsg);
  }

  logger.info(
    `Processing orchestration job for integration ${integrationId} (provider: ${integration.provider})`
  );

  let rawToken = null;
  try {
    // 5. Decrypt credential strictly at the provider boundary
    rawToken = decrypt({
      ciphertext: integration.encryptedToken,
      iv: integration.tokenIv,
      authTag: integration.tokenAuthTag,
    });

    // 6. Build unified provider-agnostic observation parameters
    const targetNs = namespace || integration.namespace || 'default';
    const targetType = workloadType || 'deployment';
    const targetName =
      workloadName || applicationName || integration.applicationName || integration.name;

    const observationParams = {
      serverUrl: integration.serverUrl,
      token: rawToken,
      caCertificate: integration.caCertificate,
      namespace: targetNs,
      workloadType: targetType,
      workloadName: targetName,
      applicationName: targetName,
      timeoutMs: 5000,
    };

    // 7. Invoke provider read-only observation
    const normalized = await providerAdapter.fetchWorkloadStatus(observationParams);

    // 8. Detect drift if supported by provider
    let drift = { hasDrift: false, reasons: [] };
    if (typeof providerAdapter.detectDrift === 'function') {
      try {
        drift = providerAdapter.detectDrift(normalized);
      } catch (driftErr) {
        logger.debug(`Drift detection non-fatal warning: ${driftErr.message}`);
      }
    }

    // 9. Map normalized state into standard schema
    const resolvedWorkloadName =
      normalized.workloadName || normalized.applicationName || targetName;
    const resolvedKind =
      normalized.workloadType ||
      (integration.provider === ORCHESTRATION_PROVIDER.ARGOCD ? 'Application' : 'Deployment');
    const resolvedNs = normalized.namespace || targetNs;
    const workloadIdentifier =
      `${integration.provider}:${resolvedKind}:${resolvedNs}:${resolvedWorkloadName}`.toLowerCase();

    const healthStatus =
      normalized.healthStatus || normalized.status || ORCHESTRATION_HEALTH_STATUS.UNKNOWN;
    const healthMessage = normalized.healthMessage || normalized.message || '';
    const syncStatus =
      normalized.syncStatus ||
      (healthStatus === ORCHESTRATION_HEALTH_STATUS.HEALTHY
        ? ORCHESTRATION_SYNC_STATUS.SYNCED
        : ORCHESTRATION_SYNC_STATUS.UNKNOWN);
    const revision = normalized.revision || normalized.currentRevision || null;

    const hasDrift = Boolean(drift?.hasDrift || normalized.hasDrift);
    const driftReasons = Array.isArray(drift?.reasons)
      ? drift.reasons
      : Array.isArray(drift?.details)
        ? drift.details
        : [];

    const runtime = {
      desiredReplicas: normalized.desiredReplicas ?? null,
      readyReplicas: normalized.readyReplicas ?? null,
      availableReplicas: normalized.availableReplicas ?? null,
      updatedReplicas: normalized.updatedReplicas ?? null,
      generation: normalized.generation ?? null,
      observedGeneration: normalized.observedGeneration ?? null,
      currentRevision: normalized.currentRevision ?? null,
      resources: normalized.resources || [],
      outOfSyncResources: normalized.outOfSyncResources || [],
      containers: normalized.containers || [],
      operationPhase: normalized.operationPhase || null,
    };

    // 10. Persist authoritative latest OrchestrationObservation
    const observation = await OrchestrationObservation.findOneAndUpdate(
      {
        integration: integration._id,
        workloadIdentifier,
      },
      {
        $set: {
          project: integration.project,
          integration: integration._id,
          provider: integration.provider,
          environment: integration.environment,
          workloadIdentifier,
          workload: {
            name: resolvedWorkloadName,
            kind: resolvedKind,
            namespace: resolvedNs,
          },
          health: {
            status: healthStatus,
            reason: normalized.healthReason || '',
            message: healthMessage,
          },
          sync: {
            status: syncStatus,
            revision,
          },
          drift: {
            hasDrift,
            reasons: driftReasons,
          },
          runtime,
          status: healthStatus,
          observedAt: new Date(),
          deliveryId: deliveryId || null,
          lastError: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 10.5 Project observation into authoritative Deployment state
    let deploymentResult = null;
    try {
      deploymentResult = await DeploymentService.ingestOrchestrationObservation(observation);
    } catch (depErr) {
      logger.error(
        `Failed to project orchestration observation into deployment state: ${depErr.message}`
      );
    }

    // 11. Update integration status
    await OrchestrationIntegration.findByIdAndUpdate(integration._id, {
      status: ORCHESTRATION_STATUS.CONNECTED,
      lastHealthCheckAt: new Date(),
      lastErrorMessage: '',
    });

    // 12. Mark delivery as succeeded
    if (deliveryId) {
      await OrchestrationDelivery.findByIdAndUpdate(deliveryId, {
        status: ORCHESTRATION_DELIVERY_STATUS.SUCCEEDED,
        processedAt: new Date(),
      });
    }

    logger.info(
      `Observation succeeded for integration ${integrationId} (${workloadIdentifier}): health=${healthStatus}, sync=${syncStatus}`
    );

    return {
      success: true,
      observationId: observation._id,
      deploymentId: deploymentResult?.deployment?._id || null,
      isNewDeployment: Boolean(deploymentResult?.isNew),
      deploymentChanged: Boolean(deploymentResult?.changed),
      workloadIdentifier,
      healthStatus,
      syncStatus,
    };
  } catch (err) {
    const safeError = sanitizeErrorMessage(err.message, rawToken);
    logger.error(`Observation failed for integration ${integrationId}: ${safeError}`);

    // Update delivery if present
    if (deliveryId) {
      await OrchestrationDelivery.findByIdAndUpdate(deliveryId, {
        status: ORCHESTRATION_DELIVERY_STATUS.FAILED,
        errorMessage: safeError,
        processedAt: new Date(),
      });
    }

    // Update integration error message
    await OrchestrationIntegration.findByIdAndUpdate(integrationId, {
      lastErrorMessage: safeError,
    });

    // Distinguish transient vs permanent
    if (isTransientError(err)) {
      throw new Error(safeError);
    } else {
      throw new UnrecoverableError(safeError);
    }
  }
}

/**
 * Process scheduled reconciliation across all active orchestration integrations.
 * Discovers integrations and enqueues observation jobs into BullMQ.
 * Does NOT call providers directly.
 *
 * @param {object} [jobData]
 * @returns {Promise<{ scheduledCount: number }>}
 */
export async function processScheduledReconciliation(_jobData = {}) {
  logger.info('Processing scheduled orchestration reconciliation discovery');

  const activeIntegrations = await OrchestrationIntegration.find({
    status: { $ne: 'deleted' },
  });

  let scheduledCount = 0;

  for (const integration of activeIntegrations) {
    try {
      await enqueueOrchestrationJob({
        integrationId: integration._id,
        projectId: integration.project,
        reason: 'scheduled_reconciliation',
        applicationName: integration.applicationName || '',
        namespace: integration.namespace || 'default',
        workloadType: 'deployment',
        workloadName: integration.name,
      });
      scheduledCount++;
    } catch (enqueueErr) {
      logger.warn(
        `Failed to enqueue scheduled reconciliation for integration ${integration._id}: ${enqueueErr.message}`
      );
    }
  }

  logger.info(
    `Scheduled reconciliation dispatched ${scheduledCount} observation jobs for ${activeIntegrations.length} active integrations`
  );

  return { scheduledCount };
}

/**
 * Initialize and start the BullMQ worker for orchestration.
 * Must be executed only by worker process entrypoint, NOT server.js.
 *
 * @returns {Worker}
 */
export function initOrchestrationWorker() {
  const queueName = config.orchestration?.queueName || 'orchestration-events';
  const concurrency = config.orchestration?.workerConcurrency || 5;

  logger.info(
    `Starting Orchestration Worker on queue '${queueName}' (concurrency: ${concurrency})`
  );

  const connection = createRedisConnection();

  const worker = new Worker(
    queueName,
    async (job) => {
      logger.info(
        `Worker picked up orchestration job #${job.id} (name: ${job.name}, type: ${job.data?.jobType})`
      );

      if (
        job.name === 'webhook_reconciliation' ||
        job.name === 'scheduled_reconciliation' ||
        job.data?.jobType === 'webhook_reconciliation' ||
        job.data?.jobType === 'scheduled_reconciliation'
      ) {
        return processOrchestrationJob(job.data);
      }

      if (job.name === 'reconcile_all_scheduled') {
        return processScheduledReconciliation(job.data);
      }

      throw new UnrecoverableError(`Unknown orchestration job name '${job.name}'`);
    },
    {
      connection,
      concurrency,
    }
  );

  worker.on('completed', (job) => {
    logger.info(`Orchestration Job #${job.id} completed successfully`);
  });

  worker.on('failed', (job, err) => {
    logger.error(
      `Orchestration Job #${job?.id} FAILED after ${job?.attemptsMade} attempt(s): ${err.message}`,
      {
        jobId: job?.id,
        integrationId: job?.data?.integrationId,
        deliveryId: job?.data?.deliveryId,
        failedReason: err.message,
      }
    );
  });

  worker.on('error', (err) => {
    logger.warn(`Orchestration Worker connection error: ${err.message}`);
  });

  return worker;
}

export default {
  processOrchestrationJob,
  processScheduledReconciliation,
  initOrchestrationWorker,
  isTransientError,
  sanitizeErrorMessage,
};

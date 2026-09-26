import { Queue } from 'bullmq';
import config from '../../config/index.js';
import { createRedisConnection } from '../../config/redis.js';
import logger from '../../shared/logger.js';

let orchestrationQueueInstance = null;
let redisClient = null;
let isMockQueue = false;

/**
 * Initialize or retrieve the singleton BullMQ Orchestration queue.
 *
 * @returns {Queue|null}
 */
export function getOrchestrationQueue() {
  if (isMockQueue) return orchestrationQueueInstance;
  if (orchestrationQueueInstance) return orchestrationQueueInstance;

  try {
    redisClient = createRedisConnection();

    orchestrationQueueInstance = new Queue(
      config.orchestration?.queueName || 'orchestration-events',
      {
        connection: redisClient,
        defaultJobOptions: {
          attempts: config.orchestration?.jobAttempts || 5,
          backoff: {
            type: 'exponential',
            delay: config.orchestration?.backoffMs || 2000,
          },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      }
    );

    orchestrationQueueInstance.on('error', (err) => {
      logger.warn(`Orchestration Queue connection warning: ${err.message}`);
    });

    logger.info(
      `Orchestration Queue initialized on channel '${config.orchestration?.queueName || 'orchestration-events'}'`
    );
    return orchestrationQueueInstance;
  } catch (err) {
    logger.warn(`Failed to initialize BullMQ orchestration queue: ${err.message}`);
    if (config.env === 'production') {
      throw err;
    }
    return null;
  }
}

/**
 * Enqueue an orchestration workload observation job into BullMQ.
 * Payload contains IDENTIFIERS ONLY.
 * NEVER place tokens, decrypted credentials, raw webhook bodies,
 * CA certificates, or sensitive request headers in job data.
 *
 * @param {object} params
 * @param {string} params.integrationId
 * @param {string|null} [params.deliveryId]
 * @param {string} params.projectId
 * @param {string} [params.reason='webhook']
 * @param {string} [params.applicationName='']
 * @param {string} [params.workloadType='']
 * @param {string} [params.workloadName='']
 * @param {string} [params.namespace='']
 * @returns {Promise<{ enqueued: boolean, jobId: string }>}
 */
export async function enqueueOrchestrationJob({
  integrationId,
  deliveryId = null,
  projectId,
  reason = 'webhook',
  applicationName = '',
  workloadType = '',
  workloadName = '',
  namespace = '',
} = {}) {
  const queue = getOrchestrationQueue();

  if (!queue) {
    const err = new Error('Orchestration BullMQ queue is unavailable');
    err.code = 'QUEUE_UNAVAILABLE';
    throw err;
  }

  const jobType = deliveryId ? 'webhook_reconciliation' : 'scheduled_reconciliation';
  const rawJobId = deliveryId
    ? `orch-del-${String(deliveryId)}`
    : `orch-sched-${String(integrationId)}-${workloadName || 'all'}-${Date.now()}`;
  const sanitizedJobId = rawJobId.replace(/[:]/g, '-');

  const jobData = {
    jobType,
    integrationId: String(integrationId),
    deliveryId: deliveryId ? String(deliveryId) : null,
    projectId: String(projectId),
    reason,
    applicationName: applicationName ? String(applicationName).trim() : '',
    workloadType: workloadType ? String(workloadType).trim() : '',
    workloadName: workloadName ? String(workloadName).trim() : '',
    namespace: namespace ? String(namespace).trim() : '',
    enqueuedAt: new Date().toISOString(),
  };

  try {
    const job = await queue.add(jobType, jobData, {
      jobId: sanitizedJobId,
    });

    logger.info(
      `Enqueued Orchestration job #${job.id} (integration: ${integrationId}, delivery: ${deliveryId || 'none'}, reason: ${reason})`
    );

    return { enqueued: true, jobId: String(job.id) };
  } catch (err) {
    logger.error(`BullMQ enqueue failed for orchestration job: ${err.message}`);
    throw err;
  }
}

/**
 * Schedule a single authoritative repeatable BullMQ reconciliation job.
 * Avoids per-process setInterval loops.
 */
export async function scheduleRepeatableOrchestrationReconciliation() {
  const queue = getOrchestrationQueue();
  if (!queue) return;

  const intervalMs = (config.orchestration?.reconciliationIntervalMinutes || 10) * 60 * 1000;

  try {
    await queue.add(
      'reconcile_all_scheduled',
      {
        reason: 'scheduled_cadence',
        enqueuedAt: new Date().toISOString(),
      },
      {
        jobId: 'orchestration_reconcile_scheduler',
        repeat: {
          every: intervalMs,
        },
      }
    );
    logger.info(
      `Scheduled repeatable orchestration reconciliation every ${config.orchestration?.reconciliationIntervalMinutes || 10} minutes`
    );
  } catch (err) {
    logger.warn(`Failed to schedule repeatable orchestration reconciliation: ${err.message}`);
  }
}

/**
 * Retrieve queue health and backlog statistics.
 */
export async function getOrchestrationQueueHealth() {
  const queue = getOrchestrationQueue();

  if (!queue) {
    return {
      available: false,
      isRedisConnected: false,
      queueName: config.orchestration?.queueName || 'orchestration-events',
      metrics: null,
      mode: 'unavailable',
    };
  }

  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return {
      available: true,
      isRedisConnected: true,
      queueName: config.orchestration?.queueName || 'orchestration-events',
      metrics: {
        waiting,
        active,
        completed,
        failed,
        delayed,
        totalBacklog: waiting + active + delayed,
      },
      mode: 'durable_bullmq',
    };
  } catch (err) {
    return {
      available: false,
      isRedisConnected: false,
      queueName: config.orchestration?.queueName || 'orchestration-events',
      error: err.message,
      mode: 'degraded',
    };
  }
}

/**
 * Gracefully close the queue and its underlying Redis connection.
 */
export async function closeOrchestrationQueue() {
  if (orchestrationQueueInstance) {
    try {
      await orchestrationQueueInstance.close();
    } catch (e) {
      logger.warn(`Error closing orchestration queue: ${e.message}`);
    }
    orchestrationQueueInstance = null;
  }
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      redisClient.disconnect();
    }
    redisClient = null;
  }
}

/**
 * Reset singleton instances for test lifecycle.
 */
export function _resetOrchestrationQueue(mockQueue) {
  if (mockQueue === undefined) {
    isMockQueue = false;
    orchestrationQueueInstance = null;
  } else {
    isMockQueue = true;
    orchestrationQueueInstance = mockQueue;
  }
}

export default {
  getOrchestrationQueue,
  enqueueOrchestrationJob,
  scheduleRepeatableOrchestrationReconciliation,
  getOrchestrationQueueHealth,
  closeOrchestrationQueue,
  _resetOrchestrationQueue,
};

import { Queue } from 'bullmq';
import config from '../../../config/index.js';
import { createRedisConnection } from '../../../config/redis.js';
import logger from '../../../shared/logger.js';

let ciQueueInstance = null;
let redisClient = null;

/**
 * Initialize or retrieve the singleton BullMQ CI events queue.
 */
export function getCiQueue() {
  if (ciQueueInstance) return ciQueueInstance;

  try {
    redisClient = createRedisConnection();

    ciQueueInstance = new Queue(config.cicd.queueName, {
      connection: redisClient,
      defaultJobOptions: {
        attempts: config.cicd.jobAttempts,
        backoff: {
          type: 'exponential',
          delay: config.cicd.backoffMs,
        },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });

    ciQueueInstance.on('error', (err) => {
      logger.warn(`CI Queue connection warning: ${err.message}`);
    });

    logger.info(`CI Queue initialized on channel '${config.cicd.queueName}'`);
    return ciQueueInstance;
  } catch (err) {
    logger.warn(`Failed to initialize BullMQ queue: ${err.message}`);
    if (config.env === 'production') {
      throw err;
    }
    return null;
  }
}

/**
 * Enqueue a GitHub webhook event for asynchronous, durable worker execution.
 */
export async function enqueueWebhookEvent({ deliveryId, event, payload }) {
  const queue = getCiQueue();

  if (queue) {
    try {
      const job = await queue.add(
        'webhook_event',
        {
          deliveryId,
          event,
          payload,
          enqueuedAt: new Date().toISOString(),
        },
        {
          jobId: deliveryId, // Deduplicate at BullMQ level
        }
      );

      logger.info(
        `Enqueued CI webhook job #${job.id} (deliveryId: ${deliveryId}, event: ${event})`
      );
      return { enqueued: true, jobId: job.id };
    } catch (err) {
      if (config.env === 'production') {
        logger.error(`BullMQ enqueue failed for deliveryId ${deliveryId}: ${err.message}`);
        throw err;
      }
      logger.warn(`BullMQ enqueue failed (${err.message}). Using local development fallback.`);
    }
  }

  // Development-only fallback when Redis is absent
  logger.warn(
    `[NON-DURABLE DEV FALLBACK] Redis/BullMQ unavailable. Executing webhook ${deliveryId} in-process. This mode does NOT provide durable delivery guarantees.`
  );

  // Lazy import processor to avoid circular dependency
  const { processWebhookJob } = await import('./ciWorker.js');
  const result = await processWebhookJob({ deliveryId, event, payload });
  return { enqueued: false, fallbackExecuted: true, result };
}

/**
 * Enqueue a manual or project-scoped reconciliation job.
 */
export async function enqueueReconciliationJob({
  projectId,
  repositoryId = null,
  lookbackMinutes = null,
  actorId = null,
}) {
  const queue = getCiQueue();
  const lookback = lookbackMinutes || config.cicd.reconciliationLookbackMinutes;

  if (queue) {
    try {
      const job = await queue.add('reconcile_repository', {
        projectId,
        repositoryId,
        lookbackMinutes: lookback,
        actorId,
        enqueuedAt: new Date().toISOString(),
      });
      return { enqueued: true, jobId: job.id };
    } catch (err) {
      if (config.env === 'production') {
        logger.error(`BullMQ reconciliation enqueue failed: ${err.message}`);
        throw err;
      }
      logger.warn(`BullMQ enqueue failed (${err.message}). Using local development fallback.`);
    }
  }

  logger.warn(
    `[NON-DURABLE DEV FALLBACK] Redis unavailable. Executing reconciliation for project ${projectId} in-process.`
  );
  const { processReconciliationJob } = await import('./ciWorker.js');
  const stats = await processReconciliationJob({
    projectId,
    repositoryId,
    lookbackMinutes: lookback,
    actorId,
  });
  return { enqueued: false, fallbackExecuted: true, stats };
}

/**
 * Schedule a single repeatable BullMQ reconciliation job across the cluster.
 */
export async function scheduleRepeatableReconciliation() {
  const queue = getCiQueue();
  if (!queue) return;

  const intervalMs = config.cicd.reconciliationIntervalMinutes * 60 * 1000;

  try {
    await queue.add(
      'reconcile_all_scheduled',
      {
        lookbackMinutes: config.cicd.reconciliationLookbackMinutes,
      },
      {
        jobId: 'reconcile_scheduler',
        repeat: {
          every: intervalMs,
        },
      }
    );
    logger.info(
      `Scheduled repeatable CI reconciliation every ${config.cicd.reconciliationIntervalMinutes} minutes`
    );
  } catch (err) {
    logger.warn(`Failed to schedule repeatable reconciliation: ${err.message}`);
  }
}

/**
 * Retrieve queue health and backlog statistics.
 */
export async function getQueueHealth() {
  const queue = getCiQueue();

  if (!queue) {
    return {
      available: false,
      isRedisConnected: false,
      queueName: config.cicd.queueName,
      metrics: null,
      mode: 'non_durable_fallback',
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
      queueName: config.cicd.queueName,
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
      queueName: config.cicd.queueName,
      error: err.message,
      mode: 'degraded',
    };
  }
}

export default {
  getCiQueue,
  enqueueWebhookEvent,
  enqueueReconciliationJob,
  scheduleRepeatableReconciliation,
  getQueueHealth,
};

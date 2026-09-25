import logger from '../../shared/logger.js';

/**
 * Enqueue an orchestration workload processing job.
 * (Queue boundary stub for Step 2; durable BullMQ worker will be implemented in Step 3).
 *
 * @param {object} params
 * @param {string} params.deliveryId
 * @param {string} params.integrationId
 * @param {string} params.projectId
 * @param {string} [params.applicationName]
 * @param {object} [params.payload]
 * @returns {Promise<{ enqueued: boolean, jobId: string|null }>}
 */
export async function enqueueOrchestrationJob(params) {
  logger.info(
    `Orchestration job queue boundary reached (stub): integration ${params.integrationId}, delivery ${params.deliveryId}`
  );
  return {
    enqueued: false,
    jobId: null,
  };
}

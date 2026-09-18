import { getCiQueue } from '../cicd/queue/ciQueue.js';
import config from '../../config/index.js';
import logger from '../../shared/logger.js';

/**
 * Enqueue a security scan report ingestion job to the shared BullMQ queue.
 * Producer-only function for asynchronous worker processing in Step 4.
 *
 * @param {object} params
 * @param {string} params.securityIntegrationId
 * @param {string} params.projectId
 * @param {string|null} [params.repositoryId]
 * @param {string|null} [params.pipelineRunId]
 * @param {string} [params.commitSha]
 * @param {string} [params.branch]
 * @param {string} [params.target]
 * @param {string} [params.scanType]
 * @param {string} [params.provider]
 * @param {string} params.reportDigest
 * @param {object} params.rawPayload
 * @returns {Promise<{ enqueued: boolean, jobId: string }>}
 */
export async function enqueueSecurityScanJob({
  securityIntegrationId,
  projectId,
  repositoryId = null,
  pipelineRunId = null,
  commitSha = '',
  branch = '',
  target = '',
  scanType = 'filesystem',
  provider = 'trivy',
  reportDigest,
  rawPayload,
}) {
  const queue = getCiQueue();
  const rawJobId = `sec-${securityIntegrationId}-${reportDigest}`;
  const sanitizedJobId = rawJobId.replace(/[:]/g, '-');

  const jobData = {
    jobType: 'security_scan_ingest',
    securityIntegrationId: String(securityIntegrationId),
    projectId: String(projectId),
    repositoryId: repositoryId ? String(repositoryId) : null,
    pipelineRunId: pipelineRunId ? String(pipelineRunId) : null,
    commitSha: commitSha ? String(commitSha).trim() : '',
    branch: branch ? String(branch).trim() : '',
    target: target ? String(target).trim() : '',
    scanType,
    provider,
    reportDigest,
    rawPayload,
    enqueuedAt: new Date().toISOString(),
  };

  if (queue) {
    try {
      const job = await queue.add('security_scan_ingest', jobData, {
        jobId: sanitizedJobId,
      });

      logger.info(
        `Enqueued Security Ingestion job #${job.id} (integration: ${securityIntegrationId}, digest: ${reportDigest.substring(0, 12)}...)`
      );
      return { enqueued: true, jobId: String(job.id) };
    } catch (err) {
      if (config.env === 'production') {
        logger.error(`BullMQ enqueue failed for security scan: ${err.message}`);
        throw err;
      }
      logger.warn(`BullMQ enqueue failed (${err.message}). Using local development fallback.`);
    }
  }

  // Development-only fallback when Redis is absent: execute in-process
  logger.warn(
    `[NON-DURABLE DEV FALLBACK] Redis/BullMQ unavailable. Executing security scan ${sanitizedJobId} in-process. This mode does NOT provide durable delivery guarantees.`
  );

  // Lazy import processor to avoid circular dependency
  const { processSecurityScanJob } = await import('./securityScanProcessor.js');
  const result = await processSecurityScanJob(jobData);
  return { enqueued: false, fallbackExecuted: true, jobId: sanitizedJobId, result };
}

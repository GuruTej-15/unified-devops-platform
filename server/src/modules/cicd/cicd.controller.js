import crypto from 'node:crypto';
import WebhookService from './webhook.service.js';
import CicdService from './cicd.service.js';
import WebhookDelivery from './webhookDelivery.model.js';
import {
  enqueueWebhookEvent,
  enqueueReconciliationJob,
  getQueueHealth as fetchQueueHealth,
} from './queue/ciQueue.js';
import config from '../../config/index.js';
import { sendSuccess, sendPaginated } from '../../shared/apiResponse.js';
import logger from '../../shared/logger.js';

/**
 * Handle incoming GitHub Webhooks (HMAC-SHA256 authenticated + Atomic Delivery Claim + Queue).
 */
export const handleGitHubWebhook = async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const deliveryId = req.headers['x-github-delivery'];
  const event = req.headers['x-github-event'];
  const secret =
    process.env.GITHUB_WEBHOOK_SECRET || config.github?.webhookSecret || 'dev-webhook-secret';

  // 1. Verify HMAC signature
  const isValid = WebhookService.verifyGitHubSignature(req.rawBody, signature, secret);
  if (!isValid) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or missing webhook signature',
    });
  }

  // 2. Validate payload and headers
  if (!deliveryId) {
    return res.status(400).json({
      success: false,
      message: 'Missing X-GitHub-Delivery header',
    });
  }

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      success: false,
      message: 'Malformed webhook payload',
    });
  }

  // 3. Compute payload digest for audit/integrity
  const payloadDigest = req.rawBody
    ? crypto.createHash('sha256').update(req.rawBody).digest('hex')
    : '';

  // 4. Atomic Webhook Delivery Claim
  const { claimed, delivery, existing } = await WebhookDelivery.claimDelivery({
    deliveryId,
    event: event || 'unknown',
    action: req.body.action || '',
    externalRepoId: String(req.body.repository?.id || ''),
    payloadDigest,
  });

  if (!claimed) {
    logger.info(`Duplicate webhook delivery ${deliveryId} received. Safely returning 202.`);
    return res.status(202).json({
      success: true,
      message: 'Duplicate webhook delivery already claimed',
      data: {
        deliveryId,
        status: existing?.status || 'already_received',
        duplicate: true,
      },
    });
  }

  // 5. Enqueue durable BullMQ job
  const enqueueResult = await enqueueWebhookEvent({
    deliveryId,
    event,
    payload: req.body,
  });

  if (delivery && enqueueResult?.jobId) {
    await WebhookDelivery.findByIdAndUpdate(delivery._id, {
      status: 'queued',
      jobId: String(enqueueResult.jobId),
    });
  }

  // 6. Fast response (HTTP 202 Accepted)
  return res.status(202).json({
    success: true,
    message: 'Webhook accepted for processing',
    data: {
      deliveryId,
      status: 'accepted',
      enqueued: enqueueResult.enqueued,
    },
  });
};

/**
 * Trigger manual asynchronous reconciliation for a project or repository.
 */
export const triggerReconciliation = async (req, res) => {
  const { repositoryId, lookbackMinutes } = req.body || {};
  const result = await enqueueReconciliationJob({
    projectId: req.params.projectId,
    repositoryId: repositoryId || null,
    lookbackMinutes: lookbackMinutes ? parseInt(lookbackMinutes, 10) : null,
    actorId: req.user.id,
  });

  return res.status(202).json({
    success: true,
    message: 'Reconciliation job accepted for processing',
    data: result,
  });
};

/**
 * Retrieve queue health and operational metrics.
 */
export const getQueueHealthStatus = async (_req, res) => {
  const health = await fetchQueueHealth();
  sendSuccess(res, { data: health });
};

/**
 * List pipeline runs for a project.
 */
export const listProjectPipelineRuns = async (req, res) => {
  const { pipelineRuns, total, page, limit } = await CicdService.listProjectPipelineRuns(
    req.params.projectId,
    req.query
  );
  sendPaginated(res, { data: pipelineRuns, total, page, limit });
};

/**
 * Get a specific pipeline run by ID.
 */
export const getPipelineRun = async (req, res) => {
  const run = await CicdService.getPipelineRunById(req.params.projectId, req.params.runId);
  sendSuccess(res, { data: run });
};

/**
 * List pipeline workflow definitions for a project.
 */
export const listProjectPipelines = async (req, res) => {
  const pipelines = await CicdService.listProjectPipelines(req.params.projectId);
  sendSuccess(res, { data: pipelines });
};

/**
 * Get pipeline runs linked to a specific issue key.
 */
export const getIssuePipelineRuns = async (req, res) => {
  const runs = await CicdService.getIssuePipelineRuns(
    req.params.projectId,
    req.params.issueKey.toUpperCase()
  );
  sendSuccess(res, { data: runs });
};

/**
 * Trigger synchronous reconciliation of workflow runs for a repository (Phase 2A fallback).
 */
export const syncRepositoryPipelines = async (req, res) => {
  const stats = await CicdService.reconcileRepositoryRuns(req.params.repoId, req.user.id);
  sendSuccess(res, { data: stats, message: 'Pipeline runs synced successfully' });
};

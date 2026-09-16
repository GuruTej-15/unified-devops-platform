import crypto from 'node:crypto';
import mongoose from 'mongoose';
import WebhookService from './webhook.service.js';
import CicdService from './cicd.service.js';
import WebhookDelivery from './webhookDelivery.model.js';
import JenkinsIntegration from './jenkinsIntegration.model.js';
import { verifyJenkinsToken } from './providers/jenkinsProvider.js';
import { getCiProvider } from './providers/providerRegistry.js';
import { CI_PROVIDER } from '../../shared/constants.js';
import { encrypt, decrypt, maskToken } from '../../shared/crypto.js';
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

/**
 * Handle incoming Jenkins Webhooks (X-Jenkins-Token authenticated against integrationId route).
 */
export const handleJenkinsWebhook = async (req, res) => {
  const { integrationId } = req.params;

  // 1. Validate integrationId format
  if (!integrationId || !mongoose.Types.ObjectId.isValid(integrationId)) {
    // Constant time dummy check to prevent timing analysis
    crypto.timingSafeEqual(Buffer.from('dummy_token_padding'), Buffer.from('dummy_token_padding'));
    return res.status(401).json({
      success: false,
      message: 'Invalid or missing webhook token',
    });
  }

  // 2. Fetch active Jenkins integration
  const integration = await JenkinsIntegration.findOne({
    _id: integrationId,
    isActive: true,
  }).select('+encryptedWebhookSecret +webhookSecretIv +webhookSecretAuthTag');

  if (!integration) {
    crypto.timingSafeEqual(Buffer.from('dummy_token_padding'), Buffer.from('dummy_token_padding'));
    return res.status(401).json({
      success: false,
      message: 'Invalid or missing webhook token',
    });
  }

  // 3. Decrypt and verify secret with X-Jenkins-Token
  const providedToken = req.headers['x-jenkins-token'];
  const expectedSecret = decrypt({
    ciphertext: integration.encryptedWebhookSecret,
    iv: integration.webhookSecretIv,
    authTag: integration.webhookSecretAuthTag,
  });

  const isValid = verifyJenkinsToken(providedToken, expectedSecret);
  if (!isValid) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or missing webhook token',
    });
  }

  // 4. Validate payload
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      success: false,
      message: 'Malformed webhook payload',
    });
  }

  // 5. Extract metadata via JenkinsProvider
  const jenkinsProvider = getCiProvider(CI_PROVIDER.JENKINS);
  const metadata = jenkinsProvider.extractDeliveryMetadata(req, { integrationId });

  // 6. Claim delivery atomically
  const { claimed, delivery, existing } = await WebhookDelivery.claimDelivery({
    deliveryId: metadata.deliveryId,
    event: metadata.event,
    action: metadata.action,
    provider: 'jenkins',
    jenkinsIntegrationId: integration._id,
    repositoryId: integration.repository,
    projectId: integration.project,
    payloadDigest: metadata.payloadDigest,
  });

  if (!claimed) {
    logger.info(
      `Duplicate Jenkins webhook delivery ${metadata.deliveryId} received. Safely returning 202.`
    );
    return res.status(202).json({
      success: true,
      message: 'Duplicate webhook delivery already claimed',
      data: {
        deliveryId: metadata.deliveryId,
        status: existing?.status || 'already_received',
        duplicate: true,
      },
    });
  }

  // 7. Enqueue BullMQ job
  const enqueueResult = await enqueueWebhookEvent({
    provider: 'jenkins',
    deliveryId: metadata.deliveryId,
    integrationId: String(integration._id),
    event: metadata.event,
    payload: req.body,
  });

  if (delivery && enqueueResult?.jobId) {
    await WebhookDelivery.findByIdAndUpdate(delivery._id, {
      status: 'queued',
      jobId: String(enqueueResult.jobId),
    });
  }

  return res.status(202).json({
    success: true,
    message: 'Webhook accepted for processing',
    data: {
      deliveryId: metadata.deliveryId,
      status: 'accepted',
      enqueued: enqueueResult.enqueued,
    },
  });
};

/**
 * Configure a new Jenkins integration for a project.
 */
export const createJenkinsIntegration = async (req, res) => {
  const { projectId } = req.params;
  const {
    repositoryId,
    jobName,
    serverUrl,
    username,
    apiToken,
    webhookSecret: customSecret,
  } = req.body;

  if (!repositoryId || !jobName || !serverUrl) {
    return res.status(400).json({
      success: false,
      message: 'repositoryId, jobName, and serverUrl are required',
    });
  }

  // Validate serverUrl
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({
        success: false,
        message: 'Invalid serverUrl: Only http and https protocols are supported',
      });
    }
  } catch {
    return res.status(400).json({
      success: false,
      message: 'Invalid serverUrl format',
    });
  }

  // Generate webhook secret if not provided
  const rawSecret = customSecret || crypto.randomBytes(32).toString('hex');
  const encSecret = encrypt(rawSecret);

  let encApiToken = null;
  let apiTokenHint = '';
  if (apiToken) {
    encApiToken = encrypt(apiToken);
    apiTokenHint = maskToken(apiToken);
  }

  const integration = await JenkinsIntegration.create({
    project: projectId,
    repository: repositoryId,
    jobName: jobName.trim(),
    serverUrl: serverUrl.trim(),
    username: username ? username.trim() : '',
    encryptedApiToken: encApiToken?.ciphertext || null,
    apiTokenIv: encApiToken?.iv || null,
    apiTokenAuthTag: encApiToken?.authTag || null,
    apiTokenHint,
    encryptedWebhookSecret: encSecret.ciphertext,
    webhookSecretIv: encSecret.iv,
    webhookSecretAuthTag: encSecret.authTag,
    webhookSecretHint: maskToken(rawSecret),
  });

  return res.status(201).json({
    success: true,
    message: 'Jenkins integration configured successfully',
    data: {
      _id: integration._id,
      project: integration.project,
      repository: integration.repository,
      jobName: integration.jobName,
      serverUrl: integration.serverUrl,
      username: integration.username,
      apiTokenHint: integration.apiTokenHint,
      webhookUrl: `/api/v1/webhooks/jenkins/${integration._id}`,
      webhookSecret: rawSecret, // Returned only once on creation
      isActive: integration.isActive,
    },
  });
};

/**
 * List active Jenkins integrations for a project.
 */
export const listJenkinsIntegrations = async (req, res) => {
  const { projectId } = req.params;
  const integrations = await JenkinsIntegration.find({ project: projectId, isActive: true })
    .populate('repository', 'name fullName defaultBranch htmlUrl')
    .lean();

  const formatted = integrations.map((item) => ({
    _id: item._id,
    project: item.project,
    repository: item.repository,
    jobName: item.jobName,
    serverUrl: item.serverUrl,
    username: item.username,
    apiTokenHint: item.apiTokenHint,
    webhookUrl: `/api/v1/webhooks/jenkins/${item._id}`,
    webhookSecretHint: item.webhookSecretHint,
    isActive: item.isActive,
    lastSyncedAt: item.lastSyncedAt,
    createdAt: item.createdAt,
  }));

  sendSuccess(res, { data: formatted });
};

/**
 * Delete / deactivate a Jenkins integration.
 */
export const deleteJenkinsIntegration = async (req, res) => {
  const { projectId, integrationId } = req.params;
  const result = await JenkinsIntegration.findOneAndDelete({
    _id: integrationId,
    project: projectId,
  });

  if (!result) {
    return res.status(404).json({
      success: false,
      message: 'Jenkins integration not found',
    });
  }

  sendSuccess(res, { message: 'Jenkins integration deleted successfully' });
};

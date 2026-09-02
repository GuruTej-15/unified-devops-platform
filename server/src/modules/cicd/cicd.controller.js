import WebhookService from './webhook.service.js';
import CicdService from './cicd.service.js';
import config from '../../config/index.js';
import { sendSuccess, sendPaginated } from '../../shared/apiResponse.js';

/**
 * Handle incoming GitHub Webhooks (HMAC-SHA256 authenticated).
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

  // 2. Validate payload structure
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      success: false,
      message: 'Malformed webhook payload',
    });
  }

  // 3. Process the event asynchronously / idempotently
  const result = await WebhookService.processGitHubWebhook({
    deliveryId,
    event,
    payload: req.body,
  });

  return res.status(result.statusCode || 202).json({
    success: result.statusCode === 202,
    message: result.ignored ? result.reason : 'Webhook processed successfully',
    data: result.data || null,
  });
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
 * Trigger manual reconciliation of workflow runs for a repository.
 */
export const syncRepositoryPipelines = async (req, res) => {
  const stats = await CicdService.reconcileRepositoryRuns(req.params.repoId, req.user.id);
  sendSuccess(res, { data: stats, message: 'Pipeline runs synced successfully' });
};

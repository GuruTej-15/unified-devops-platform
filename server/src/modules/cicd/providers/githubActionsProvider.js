import crypto from 'node:crypto';
import BaseCiProvider from './baseCiProvider.js';
import { CI_PROVIDER } from '../../../shared/constants.js';
import logger from '../../../shared/logger.js';

export default class GitHubActionsProvider extends BaseCiProvider {
  getProviderName() {
    return CI_PROVIDER.GITHUB_ACTIONS;
  }

  /**
   * Constant-time HMAC-SHA256 signature verification for GitHub webhooks.
   */
  verifyWebhookSignature(req, { secret } = {}) {
    const signatureHeader = req.headers['x-hub-signature-256'];
    const rawBody = req.rawBody;

    if (!signatureHeader || !secret || !rawBody) {
      return false;
    }

    try {
      const parts = signatureHeader.split('=');
      if (parts.length !== 2 || parts[0] !== 'sha256') {
        return false;
      }

      const receivedDigest = Buffer.from(parts[1], 'hex');
      const expectedDigest = crypto.createHmac('sha256', secret).update(rawBody).digest();

      if (receivedDigest.length !== expectedDigest.length) {
        return false;
      }

      return crypto.timingSafeEqual(receivedDigest, expectedDigest);
    } catch (err) {
      logger.error('GitHubActionsProvider signature verification error:', err.message);
      return false;
    }
  }

  /**
   * Extract delivery metadata from GitHub headers.
   */
  extractDeliveryMetadata(req) {
    const deliveryId = req.headers['x-github-delivery'] || '';
    const event = req.headers['x-github-event'] || 'workflow_run';
    const action = req.body?.action || '';
    const externalRepoId = String(req.body?.repository?.id || '');
    const payloadDigest = req.rawBody
      ? crypto.createHash('sha256').update(req.rawBody).digest('hex')
      : '';

    return {
      deliveryId,
      event,
      action,
      externalRepoId,
      payloadDigest,
    };
  }

  /**
   * Normalize GitHub workflow_run payload into standard normalized data structure.
   */
  async normalizeWebhookPayload(payload, metadata = {}) {
    const { workflow_run: run, repository: repoPayload, action } = payload;
    if (!run || !repoPayload) {
      throw new Error('Malformed GitHub workflow_run webhook payload');
    }

    // 1. Text sources for issue key extraction
    const textSources = [run.head_commit?.message || '', run.head_branch || ''];
    if (Array.isArray(run.pull_requests)) {
      for (const pr of run.pull_requests) {
        if (pr.head?.ref) textSources.push(pr.head.ref);
        if (pr.title) textSources.push(pr.title);
      }
    }

    // 2. Duration calculation
    let duration = null;
    if (run.run_started_at && run.updated_at && run.status === 'completed') {
      const start = new Date(run.run_started_at).getTime();
      const end = new Date(run.updated_at).getTime();
      if (!isNaN(start) && !isNaN(end) && end >= start) {
        duration = Math.round((end - start) / 1000);
      }
    }

    const prNumber = run.pull_requests?.[0]?.number || null;

    return {
      provider: CI_PROVIDER.GITHUB_ACTIONS,
      jenkinsIntegration: null,
      externalRunId: String(run.id),
      externalWorkflowId: String(run.workflow_id),
      runNumber: run.run_number || 1,
      workflowName: run.name || 'CI Workflow',
      workflowPath: run.path || '',
      commitSha: run.head_sha || '',
      branch: run.head_branch || '',
      pullRequestNumber: prNumber,
      textForIssueKeyExtraction: textSources,
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
      providerEvent: metadata.event || 'workflow_run',
      providerAction: action || run.status || '',
      externalRepoId: String(repoPayload.id),
    };
  }
}

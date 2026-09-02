import crypto from 'node:crypto';
import Repository from '../vcs/repository.model.js';
import Project from '../projects/project.model.js';
import Issue from '../issues/issue.model.js';
import PullRequest from '../vcs/pullRequest.model.js';
import Pipeline from './pipeline.model.js';
import PipelineRun from './pipelineRun.model.js';
import { extractIssueKeys } from '../../shared/issueKeyParser.js';
import eventBus from '../notifications/eventBus.js';
import logger from '../../shared/logger.js';

export default class WebhookService {
  /**
   * Constant-time HMAC-SHA256 signature verification for GitHub webhooks.
   */
  static verifyGitHubSignature(rawBody, signatureHeader, secret) {
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
      logger.error('Signature verification error:', err.message);
      return false;
    }
  }

  /**
   * Validates candidate issue keys against the project's namespace and existing database issues.
   * Multi-step algorithm: Candidate Keys -> Valid Project Prefix -> Existing Issue -> Traceability Link
   */
  static async _validateIssueKeys(candidateKeys, project) {
    if (!candidateKeys || candidateKeys.length === 0 || !project) return [];

    const projectPrefix = `${project.key}-`;
    const namespaceMatches = candidateKeys.filter((k) => k.startsWith(projectPrefix));
    if (namespaceMatches.length === 0) return [];

    const existingIssues = await Issue.find({
      project: project._id,
      issueKey: { $in: namespaceMatches },
    }).select('issueKey');

    return existingIssues.map((i) => i.issueKey);
  }

  /**
   * Processes a GitHub webhook event (primarily `workflow_run`).
   * Enforces idempotency via atomic upsert on { repository, externalRunId }.
   */
  static async processGitHubWebhook({ deliveryId, event, payload }) {
    // Only process workflow_run events in Phase 2A
    if (event !== 'workflow_run') {
      return {
        statusCode: 202,
        ignored: true,
        reason: `Event '${event}' ignored. Phase 2A handles 'workflow_run'.`,
      };
    }

    const { workflow_run: run, repository: repoPayload, action } = payload;
    if (!run || !repoPayload) {
      return {
        statusCode: 400,
        error: 'Malformed workflow_run webhook payload',
      };
    }

    // 1. Resolve Platform Repository by numeric GitHub externalId
    const repository = await Repository.findOne({ externalId: String(repoPayload.id) });
    if (!repository) {
      logger.info(
        `Webhook ignored: Repository ${repoPayload.full_name} (ID: ${repoPayload.id}) is not connected.`
      );
      return {
        statusCode: 202,
        ignored: true,
        reason: 'Repository not connected to any project',
      };
    }

    // 2. Resolve Project
    const project = await Project.findById(repository.project);
    if (!project) {
      logger.warn(`Project not found for connected repository ID ${repository._id}`);
      return {
        statusCode: 202,
        ignored: true,
        reason: 'Associated project not found',
      };
    }

    // 3. Find or create Pipeline definition (Workflow)
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

    // 6. Find Associated PR in DB if present
    let associatedPr = null;
    const prNumber = run.pull_requests?.[0]?.number || null;
    if (prNumber) {
      associatedPr = await PullRequest.findOne({
        repository: repository._id,
        number: prNumber,
      });
    }

    // 7. Atomic Idempotent Upsert for PipelineRun
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

    const pipelineRun = await PipelineRun.findOneAndUpdate(
      {
        repository: repository._id,
        externalRunId: String(run.id),
      },
      runData,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 8. Emit Domain Events
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

    return {
      statusCode: 202,
      success: true,
      data: {
        runId: pipelineRun._id,
        externalRunId: pipelineRun.externalRunId,
        status: pipelineRun.status,
        conclusion: pipelineRun.conclusion,
      },
    };
  }
}

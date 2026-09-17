import crypto from 'node:crypto';
import BaseCiProvider from './baseCiProvider.js';
import { CI_PROVIDER, PIPELINE_STATUS, PIPELINE_CONCLUSION } from '../../../shared/constants.js';
import logger from '../../../shared/logger.js';

/**
 * Constant-time string equality check for Jenkins tokens.
 * Enforces identical byte lengths before comparing to prevent timing side channels.
 */
export function verifyJenkinsToken(providedToken, expectedSecret) {
  if (!providedToken || !expectedSecret) {
    return false;
  }

  try {
    const provBuf = Buffer.from(String(providedToken), 'utf8');
    const expBuf = Buffer.from(String(expectedSecret), 'utf8');

    if (provBuf.length !== expBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(provBuf, expBuf);
  } catch (err) {
    logger.error('JenkinsProvider token verification error:', err.message);
    return false;
  }
}

export default class JenkinsProvider extends BaseCiProvider {
  getProviderName() {
    return CI_PROVIDER.JENKINS;
  }

  /**
   * Verify Jenkins webhook token from header X-Jenkins-Token.
   */
  verifyWebhookSignature(req, { secret } = {}) {
    const token = req.headers['x-jenkins-token'];
    return verifyJenkinsToken(token, secret);
  }

  /**
   * Extract delivery metadata from Jenkins request.
   */
  extractDeliveryMetadata(req, { integrationId } = {}) {
    const body = req.body || {};
    const buildNumber = body.build?.number || body.buildNumber || body.number || body.id || '0';
    const phase = (
      body.build?.phase ||
      body.phase ||
      body.build?.status ||
      body.status ||
      'build'
    ).toLowerCase();

    // Prefer genuine Jenkins request identifier headers if available
    const deliveryId =
      req.headers['x-jenkins-delivery'] ||
      req.headers['x-delivery-id'] ||
      req.headers['x-request-id'] ||
      `jenkins:${integrationId || 'unknown'}:${buildNumber}:${phase}`;

    const event = req.headers['x-jenkins-event'] || 'build';
    const action = phase;
    const payloadDigest = req.rawBody
      ? crypto.createHash('sha256').update(req.rawBody).digest('hex')
      : '';

    return {
      deliveryId,
      event,
      action,
      payloadDigest,
      integrationId,
    };
  }

  /**
   * Normalize Jenkins webhook payload into the standard platform PipelineRun structure.
   */
  async normalizeWebhookPayload(payload, metadata = {}, { integration, repository } = {}) {
    const buildObj = payload.build || payload;
    const rawNumber = buildObj.number || payload.buildNumber || payload.number || payload.id;
    if (rawNumber === undefined || rawNumber === null) {
      throw new Error('Malformed Jenkins webhook payload: missing build number');
    }

    const runNumber = parseInt(rawNumber, 10) || 1;
    const externalRunId = String(runNumber);

    // Job / Workflow Name
    const workflowName =
      payload.name || payload.jobName || integration?.jobName || 'Jenkins Pipeline';

    // Status & Conclusion mapping
    const rawPhase = (buildObj.phase || payload.phase || '').toUpperCase();
    const rawStatus = (buildObj.status || payload.status || payload.result || '').toUpperCase();
    const isBuilding = buildObj.building === true || payload.building === true;

    let status = PIPELINE_STATUS.QUEUED;
    let conclusion = null;

    if (rawPhase === 'STARTED' || rawPhase === 'RUNNING' || isBuilding) {
      status = PIPELINE_STATUS.IN_PROGRESS;
      conclusion = null;
    } else if (rawPhase === 'FINALIZED' || rawPhase === 'COMPLETED' || rawStatus) {
      status = PIPELINE_STATUS.COMPLETED;
      switch (rawStatus) {
        case 'SUCCESS':
          conclusion = PIPELINE_CONCLUSION.SUCCESS;
          break;
        case 'FAILURE':
        case 'UNSTABLE':
          conclusion = PIPELINE_CONCLUSION.FAILURE;
          break;
        case 'ABORTED':
          conclusion = PIPELINE_CONCLUSION.CANCELLED;
          break;
        default:
          conclusion = PIPELINE_CONCLUSION.SUCCESS; // Default completed result if not explicitly failure
      }
    } else if (rawPhase === 'QUEUED') {
      status = PIPELINE_STATUS.QUEUED;
      conclusion = null;
    }

    // Git Commit & Branch (optional / nullable without fabrication)
    let commitSha =
      buildObj.scm?.commit ||
      buildObj.git_commit ||
      payload.commit ||
      payload.commitSha ||
      payload.head_sha ||
      '';

    let branch =
      buildObj.scm?.branch || buildObj.git_branch || payload.branch || payload.head_branch || '';

    // Strip leading 'origin/' or 'refs/heads/' from branch name if present
    if (branch.startsWith('refs/heads/')) {
      branch = branch.replace('refs/heads/', '');
    } else if (branch.startsWith('origin/')) {
      branch = branch.replace('origin/', '');
    }

    // Duration (in seconds)
    let duration = null;
    if (typeof buildObj.duration === 'number' && buildObj.duration > 0) {
      // Jenkins Notification Plugin reports duration in milliseconds
      duration = Math.round(
        buildObj.duration > 1000 ? buildObj.duration / 1000 : buildObj.duration
      );
    } else if (typeof payload.duration === 'number') {
      duration = Math.round(payload.duration > 1000 ? payload.duration / 1000 : payload.duration);
    }

    // Timestamps
    let startedAt = null;
    if (buildObj.timestamp) {
      startedAt = new Date(buildObj.timestamp);
    } else if (payload.timestamp) {
      startedAt = new Date(payload.timestamp);
    }

    let completedAt = null;
    if (status === PIPELINE_STATUS.COMPLETED) {
      if (startedAt && duration) {
        completedAt = new Date(startedAt.getTime() + duration * 1000);
      } else {
        completedAt = new Date();
      }
    }

    // Actor
    let actorLogin = 'jenkins';
    const causes = buildObj.causes || payload.causes;
    if (Array.isArray(causes) && causes.length > 0) {
      actorLogin = causes[0].userName || causes[0].userId || 'jenkins';
    } else if (payload.actor) {
      actorLogin =
        typeof payload.actor === 'string' ? payload.actor : payload.actor.login || 'jenkins';
    }

    // Text sources for issue key extraction (commit messages, branch, changeSet)
    const textSources = [branch];
    const headCommitMessage =
      buildObj.scm?.commitMessage || payload.headCommitMessage || payload.commitMessage || '';
    if (headCommitMessage) {
      textSources.push(headCommitMessage);
    }

    // Process changeSet items if available
    const changeSet = buildObj.changeSet || payload.changeSet;
    if (changeSet?.items && Array.isArray(changeSet.items)) {
      for (const item of changeSet.items) {
        if (item.comment || item.msg) {
          textSources.push(item.comment || item.msg);
        }
        if (!commitSha && item.commitId) {
          commitSha = item.commitId;
        }
      }
    }

    const htmlUrl = buildObj.full_url || buildObj.url || payload.buildUrl || payload.url || '';

    const integrationId = integration?._id || metadata.integrationId || null;

    return {
      provider: CI_PROVIDER.JENKINS,
      jenkinsIntegration: integrationId,
      externalRunId,
      externalWorkflowId: integration?.jobName || workflowName,
      runNumber,
      workflowName,
      workflowPath: 'Jenkinsfile',
      commitSha,
      branch,
      pullRequestNumber: payload.pullRequestNumber || null,
      textForIssueKeyExtraction: textSources,
      eventType: payload.eventType || 'push',
      status,
      conclusion,
      htmlUrl,
      startedAt,
      completedAt,
      duration,
      actor: {
        login: actorLogin,
        avatarUrl: '',
      },
      headCommitMessage,
      providerEvent: metadata.event || 'build',
      providerAction: rawPhase || rawStatus || '',
      externalRepoId: repository?.externalId || '',
    };
  }
}

import mongoose from 'mongoose';
import Deployment from './deployment.model.js';
import PipelineRun from '../cicd/pipelineRun.model.js';
import SecurityScan from '../security/securityScan.model.js';
import PolicyGateResult from '../security/policyGateResult.model.js';
import Commit from '../vcs/commit.model.js';
import AuditService from '../audit/audit.service.js';
import { publishDeploymentEvent } from '../cicd/events/ciEventBridge.js';
import {
  DEPLOYMENT_STATUS,
  DEPLOYMENT_GOVERNANCE_STATE,
  DEPLOYMENT_EVENTS,
  POLICY_EVALUATION_STATE,
  POLICY_ENFORCEMENT,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
} from '../../shared/constants.js';
import { mapObservationToDeploymentStatus } from './deploymentStatusMapper.js';
import logger from '../../shared/logger.js';

export default class DeploymentService {
  /**
   * Determine authoritative governance decision for a deployment candidate
   * based on linked pipeline run and security scan policy results.
   *
   * @param {string|mongoose.Types.ObjectId} projectId
   * @param {object} params
   * @param {string|null} [params.pipelineRunId]
   * @param {string|null} [params.commitSha]
   * @returns {Promise<{ governanceDecision: string, gateResultId: string|null, isOverridden: boolean }>}
   */
  static async evaluateDeploymentGovernance(
    projectId,
    { pipelineRunId = null, commitSha = null } = {}
  ) {
    try {
      let scan = null;

      // 1. Trace via PipelineRun if provided
      if (pipelineRunId && mongoose.Types.ObjectId.isValid(pipelineRunId)) {
        scan = await SecurityScan.findOne({
          project: projectId,
          pipelineRun: pipelineRunId,
        }).sort({ createdAt: -1 });
      }

      // 2. Trace via commitSha directly or via PipelineRun
      if (!scan && commitSha && typeof commitSha === 'string' && commitSha.trim()) {
        const cleanSha = commitSha.trim();
        scan = await SecurityScan.findOne({
          project: projectId,
          commitSha: cleanSha,
        }).sort({ createdAt: -1 });

        if (!scan) {
          const matchingRuns = await PipelineRun.find({
            project: projectId,
            commitSha: cleanSha,
          }).select('_id');

          if (matchingRuns && matchingRuns.length > 0) {
            const runIds = matchingRuns.map((r) => r._id);
            scan = await SecurityScan.findOne({
              project: projectId,
              pipelineRun: { $in: runIds },
            }).sort({ createdAt: -1 });
          }
        }
      }

      // If no scan exists for this pipeline run/commit: NOT_EVALUATED
      if (!scan) {
        return {
          governanceDecision: DEPLOYMENT_GOVERNANCE_STATE.NOT_EVALUATED,
          gateResultId: null,
          isOverridden: false,
        };
      }

      // 3. Inspect PolicyGateResults if any exist
      const gateResults = await PolicyGateResult.find({
        project: projectId,
        scan: scan._id,
      });

      if (gateResults && gateResults.length > 0) {
        const blockingResults = gateResults.filter(
          (gr) => gr.enforcement === POLICY_ENFORCEMENT.BLOCKING && !gr.passed
        );

        if (blockingResults.length > 0) {
          const allOverridden = blockingResults.every((gr) => gr.isOverridden);
          if (allOverridden) {
            return {
              governanceDecision: DEPLOYMENT_GOVERNANCE_STATE.OVERRIDDEN,
              gateResultId: blockingResults[0]._id,
              isOverridden: true,
            };
          }
          return {
            governanceDecision: DEPLOYMENT_GOVERNANCE_STATE.BLOCKED,
            gateResultId: blockingResults[0]._id,
            isOverridden: false,
          };
        }

        // Policy rules evaluated and no blocking failures
        return {
          governanceDecision: DEPLOYMENT_GOVERNANCE_STATE.ALLOWED,
          gateResultId: gateResults[0]._id,
          isOverridden: false,
        };
      }

      // 4. Fallback to scan.gateStatus if no individual PolicyGateResult documents exist
      const normalizedGateStatus = String(scan.gateStatus || '')
        .trim()
        .toUpperCase();
      if (
        normalizedGateStatus === POLICY_EVALUATION_STATE.PASS ||
        normalizedGateStatus === POLICY_EVALUATION_STATE.WARNING
      ) {
        return {
          governanceDecision: DEPLOYMENT_GOVERNANCE_STATE.ALLOWED,
          gateResultId: null,
          isOverridden: false,
        };
      }

      if (normalizedGateStatus === POLICY_EVALUATION_STATE.FAIL) {
        return {
          governanceDecision: DEPLOYMENT_GOVERNANCE_STATE.BLOCKED,
          gateResultId: null,
          isOverridden: false,
        };
      }

      return {
        governanceDecision: DEPLOYMENT_GOVERNANCE_STATE.NOT_EVALUATED,
        gateResultId: null,
        isOverridden: false,
      };
    } catch (err) {
      logger.error(`DeploymentService.evaluateDeploymentGovernance error: ${err.message}`);
      return {
        governanceDecision: DEPLOYMENT_GOVERNANCE_STATE.NOT_EVALUATED,
        gateResultId: null,
        isOverridden: false,
      };
    }
  }

  /**
   * Atomically ingest or update a deployment record, evaluating governance state
   * and emitting real-time Redis/Socket.io events and audit logs.
   *
   * @param {string|mongoose.Types.ObjectId} projectId
   * @param {object} deploymentData
   * @returns {Promise<object>}
   */
  static async recordDeployment(projectId, deploymentData) {
    const {
      externalDeploymentId,
      provider = 'github_actions',
      environment = 'production',
      status = DEPLOYMENT_STATUS.QUEUED,
      pipelineRunId = null,
      repositoryId = null,
      commitSha = '',
      branch = '',
      url = null,
      actor = null,
      startedAt = null,
      completedAt = null,
      duration = null,
      errorMessage = null,
      metadata = {},
    } = deploymentData;

    if (!externalDeploymentId) {
      throw new Error('externalDeploymentId is required');
    }

    const cleanEnv = String(environment || 'production')
      .trim()
      .toLowerCase();
    const cleanExternalId = String(externalDeploymentId).trim();
    const cleanCommitSha = String(commitSha || '').trim();
    const cleanBranch = String(branch || '').trim();

    // 1. Authoritative Governance Evaluation
    const { governanceDecision, gateResultId } =
      await DeploymentService.evaluateDeploymentGovernance(projectId, {
        pipelineRunId,
        commitSha: cleanCommitSha,
      });

    // 2. Clear distinction: Violation occurs if external deployment completed (success) despite BLOCKED gate
    const isSuccess = status === DEPLOYMENT_STATUS.SUCCESS;
    const isBlocked = governanceDecision === DEPLOYMENT_GOVERNANCE_STATE.BLOCKED;
    const isGovernanceViolation = isSuccess && isBlocked;

    // 3. Timestamps & duration calculation
    let resolvedStartedAt = startedAt ? new Date(startedAt) : null;
    let resolvedCompletedAt = completedAt ? new Date(completedAt) : null;

    if ((status === DEPLOYMENT_STATUS.IN_PROGRESS || isSuccess) && !resolvedStartedAt) {
      resolvedStartedAt = new Date();
    }
    if (
      (isSuccess ||
        status === DEPLOYMENT_STATUS.FAILED ||
        status === DEPLOYMENT_STATUS.CANCELLED) &&
      !resolvedCompletedAt
    ) {
      resolvedCompletedAt = new Date();
    }

    let calculatedDuration = duration;
    if (calculatedDuration == null && resolvedStartedAt && resolvedCompletedAt) {
      const diffMs = resolvedCompletedAt.getTime() - resolvedStartedAt.getTime();
      if (!isNaN(diffMs) && diffMs >= 0) {
        calculatedDuration = Math.round(diffMs / 1000);
      }
    }

    // 4. Atomic Idempotent Upsert scoped to (project, provider, environment, externalDeploymentId)
    const filter = {
      project: projectId,
      provider,
      environment: cleanEnv,
      externalDeploymentId: cleanExternalId,
    };

    const updateDoc = {
      $set: {
        status,
        governanceDecision,
        governanceGateResult: gateResultId,
        isGovernanceViolation,
        commitSha: cleanCommitSha,
        branch: cleanBranch,
        url: url || null,
        actor: actor || null,
        startedAt: resolvedStartedAt,
        completedAt: resolvedCompletedAt,
        duration: calculatedDuration,
        errorMessage: errorMessage || null,
        metadata: metadata || {},
        updatedAt: new Date(),
      },
      $setOnInsert: {
        project: projectId,
        provider,
        environment: cleanEnv,
        externalDeploymentId: cleanExternalId,
        createdAt: new Date(),
      },
    };

    if (pipelineRunId && mongoose.Types.ObjectId.isValid(pipelineRunId)) {
      updateDoc.$set.pipelineRun = pipelineRunId;
    }
    if (repositoryId && mongoose.Types.ObjectId.isValid(repositoryId)) {
      updateDoc.$set.repository = repositoryId;
    }

    const deployment = await Deployment.findOneAndUpdate(filter, updateDoc, {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    });

    // 5. Audit Logging (never contains raw tokens or secrets)
    AuditService.log({
      action: AUDIT_ACTIONS.DEPLOYMENT_UPDATED,
      actor: actor || null,
      entityType: ENTITY_TYPES.DEPLOYMENT,
      entityId: deployment._id,
      projectId,
      metadata: {
        provider,
        environment: cleanEnv,
        status,
        externalDeploymentId: cleanExternalId,
        governanceDecision,
        isGovernanceViolation,
        commitSha: cleanCommitSha,
      },
    }).catch((err) => logger.warn(`Audit log failed for deployment: ${err.message}`));

    // 6. Real-time Event Publication (Redis Pub/Sub -> Socket.io)
    // Map deployment status to event type
    let eventType = DEPLOYMENT_EVENTS.COMPLETED;
    if (status === DEPLOYMENT_STATUS.QUEUED) {
      eventType = DEPLOYMENT_EVENTS.QUEUED;
    } else if (status === DEPLOYMENT_STATUS.IN_PROGRESS) {
      eventType = DEPLOYMENT_EVENTS.STARTED;
    } else if (status === DEPLOYMENT_STATUS.FAILED || status === DEPLOYMENT_STATUS.CANCELLED) {
      eventType = DEPLOYMENT_EVENTS.FAILED;
    }

    try {
      await publishDeploymentEvent(eventType, {
        projectId: String(projectId),
        deploymentId: String(deployment._id),
        externalDeploymentId: cleanExternalId,
        provider,
        environment: cleanEnv,
        status,
        governanceDecision,
        isGovernanceViolation,
        commitSha: cleanCommitSha,
        branch: cleanBranch,
        url: deployment.url,
        actor: deployment.actor,
        duration: deployment.duration,
        completedAt: deployment.completedAt,
      });
    } catch (pubErr) {
      // Event publication failure must never roll back DB persistence
      logger.error(`Deployment real-time publish error: ${pubErr.message}`);
    }

    return deployment;
  }

  /**
   * Alias for recordDeployment.
   */
  static async ingestDeployment(projectId, deploymentData) {
    return DeploymentService.recordDeployment(projectId, deploymentData);
  }

  /**
   * Ingest a normalized OrchestrationObservation into the authoritative Deployment domain.
   *
   * Idempotent & Drift-Aware:
   * - Scoped by (project, provider, environment, externalDeploymentId = workloadIdentifier).
   * - Reuses Phase 3 governance evaluation engine (evaluateDeploymentGovernance).
   * - Distinguishes new vs updated vs unchanged observations.
   * - Suppresses duplicate real-time event publication when observation state is unchanged.
   * - Persists rich orchestration metadata and drift details without leaking credentials.
   *
   * @param {object} observation - Normalized OrchestrationObservation doc or object
   * @param {object} [options]
   * @param {string} [options.actor]
   * @returns {Promise<{ deployment: object, isNew: boolean, changed: boolean }>}
   */
  static async ingestOrchestrationObservation(observation, options = {}) {
    if (!observation) {
      throw new Error('Observation is required for ingestion');
    }

    const projectId = observation.project;
    const provider = observation.provider;
    const environment = String(observation.environment || 'production')
      .trim()
      .toLowerCase();
    const workloadIdentifier = String(observation.workloadIdentifier || '').trim();

    if (!projectId || !provider || !workloadIdentifier) {
      throw new Error('Observation must contain project, provider, and workloadIdentifier');
    }

    // 1. Extract commit SHA / revision if present
    const rawRevision = observation.sync?.revision || observation.runtime?.currentRevision || '';
    const cleanCommitSha = typeof rawRevision === 'string' ? rawRevision.trim() : '';

    // 2. Map normalized health/sync/runtime into deployment status
    const mappedStatus = mapObservationToDeploymentStatus(observation);

    // 3. Authoritative Governance Evaluation (reusing Phase 3 policy gate evaluation)
    const { governanceDecision, gateResultId } =
      await DeploymentService.evaluateDeploymentGovernance(projectId, {
        commitSha: cleanCommitSha,
      });

    // 4. Governance Violation Detection:
    // A violation occurs when external deployment succeeded despite a BLOCKED gate
    const isSuccess = mappedStatus === DEPLOYMENT_STATUS.SUCCESS;
    const isBlocked = governanceDecision === DEPLOYMENT_GOVERNANCE_STATE.BLOCKED;
    const isGovernanceViolation = isSuccess && isBlocked;

    // 5. Look up existing authoritative deployment record
    const filter = {
      project: projectId,
      provider,
      environment,
      externalDeploymentId: workloadIdentifier,
    };

    const existing = await Deployment.findOne(filter);
    const isNew = !existing;

    // 6. Assemble rich normalized metadata & drift
    const hasDrift = Boolean(observation.drift?.hasDrift);
    const driftReasons = Array.isArray(observation.drift?.reasons) ? observation.drift.reasons : [];

    const orchestrationMetadata = {
      integrationId: observation.integration || null,
      workloadIdentifier,
      workload: observation.workload || {},
      healthStatus: observation.health?.status || null,
      healthReason: observation.health?.reason || '',
      healthMessage: observation.health?.message || '',
      syncStatus: observation.sync?.status || null,
      observedAt: observation.observedAt || new Date(),
    };

    const runtimeMetadata = {
      desiredReplicas: observation.runtime?.desiredReplicas ?? null,
      readyReplicas: observation.runtime?.readyReplicas ?? null,
      availableReplicas: observation.runtime?.availableReplicas ?? null,
      updatedReplicas: observation.runtime?.updatedReplicas ?? null,
      generation: observation.runtime?.generation ?? null,
      observedGeneration: observation.runtime?.observedGeneration ?? null,
      operationPhase: observation.runtime?.operationPhase ?? null,
    };

    const newMetadata = {
      ...(existing?.metadata || {}),
      orchestration: orchestrationMetadata,
      drift: {
        hasDrift,
        reasons: driftReasons,
      },
      runtime: runtimeMetadata,
    };

    // 7. Check if meaningful state changed (Idempotency & duplicate suppression)
    let hasChanged = true;
    if (existing) {
      const statusUnchanged = existing.status === mappedStatus;
      const shaUnchanged = (existing.commitSha || '') === cleanCommitSha;
      const govUnchanged = existing.governanceDecision === governanceDecision;
      const violUnchanged = existing.isGovernanceViolation === isGovernanceViolation;
      const driftUnchanged =
        Boolean(existing.metadata?.drift?.hasDrift) === hasDrift &&
        JSON.stringify(existing.metadata?.drift?.reasons || []) === JSON.stringify(driftReasons);
      const healthUnchanged =
        existing.metadata?.orchestration?.healthStatus === observation.health?.status;
      const syncUnchanged =
        existing.metadata?.orchestration?.syncStatus === observation.sync?.status;

      if (
        statusUnchanged &&
        shaUnchanged &&
        govUnchanged &&
        violUnchanged &&
        driftUnchanged &&
        healthUnchanged &&
        syncUnchanged
      ) {
        hasChanged = false;
      }
    }

    // If completely unchanged, return existing authoritative document without duplicating events or audits
    if (!isNew && !hasChanged) {
      return {
        deployment: existing,
        isNew: false,
        changed: false,
      };
    }

    // 8. Timestamps & duration
    let resolvedStartedAt = existing?.startedAt || null;
    let resolvedCompletedAt = existing?.completedAt || null;

    if ((mappedStatus === DEPLOYMENT_STATUS.IN_PROGRESS || isSuccess) && !resolvedStartedAt) {
      resolvedStartedAt = new Date();
    }
    if (
      (isSuccess ||
        mappedStatus === DEPLOYMENT_STATUS.FAILED ||
        mappedStatus === DEPLOYMENT_STATUS.CANCELLED) &&
      !resolvedCompletedAt
    ) {
      resolvedCompletedAt = observation.observedAt ? new Date(observation.observedAt) : new Date();
    }

    let calculatedDuration = existing?.duration || null;
    if (calculatedDuration == null && resolvedStartedAt && resolvedCompletedAt) {
      const diffMs = resolvedCompletedAt.getTime() - resolvedStartedAt.getTime();
      if (!isNaN(diffMs) && diffMs >= 0) {
        calculatedDuration = Math.round(diffMs / 1000);
      }
    }

    const updateDoc = {
      $set: {
        status: mappedStatus,
        governanceDecision,
        governanceGateResult: gateResultId,
        isGovernanceViolation,
        commitSha: cleanCommitSha || existing?.commitSha || '',
        branch: existing?.branch || '',
        url: existing?.url || null,
        actor: options.actor || existing?.actor || null,
        startedAt: resolvedStartedAt,
        completedAt: resolvedCompletedAt,
        duration: calculatedDuration,
        errorMessage: observation.lastError?.message || null,
        metadata: newMetadata,
        orchestrationObservation: observation._id || null,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        project: projectId,
        provider,
        environment,
        externalDeploymentId: workloadIdentifier,
        createdAt: new Date(),
      },
    };

    // 9. Authoritative atomic persistence in MongoDB
    const deployment = await Deployment.findOneAndUpdate(filter, updateDoc, {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    });

    // 10. Audit Logging (persisted before real-time event, safe metadata only)
    AuditService.log({
      action: isNew ? AUDIT_ACTIONS.DEPLOYMENT_CREATED : AUDIT_ACTIONS.DEPLOYMENT_UPDATED,
      actor: options.actor || null,
      entityType: ENTITY_TYPES.DEPLOYMENT,
      entityId: deployment._id,
      projectId,
      metadata: {
        provider,
        environment,
        status: mappedStatus,
        externalDeploymentId: workloadIdentifier,
        governanceDecision,
        isGovernanceViolation,
        commitSha: cleanCommitSha,
        hasDrift,
      },
    }).catch((err) => logger.warn(`Audit log failed for orchestration deployment: ${err.message}`));

    // 11. Real-time Event Publication (Redis Pub/Sub -> Socket.io)
    // Map deployment status to domain event type
    let eventType = DEPLOYMENT_EVENTS.COMPLETED;
    if (mappedStatus === DEPLOYMENT_STATUS.QUEUED) {
      eventType = DEPLOYMENT_EVENTS.QUEUED;
    } else if (mappedStatus === DEPLOYMENT_STATUS.IN_PROGRESS) {
      eventType = DEPLOYMENT_EVENTS.STARTED;
    } else if (
      mappedStatus === DEPLOYMENT_STATUS.FAILED ||
      mappedStatus === DEPLOYMENT_STATUS.CANCELLED
    ) {
      eventType = DEPLOYMENT_EVENTS.FAILED;
    }

    try {
      await publishDeploymentEvent(eventType, {
        projectId: String(projectId),
        deploymentId: String(deployment._id),
        externalDeploymentId: workloadIdentifier,
        provider,
        environment,
        status: mappedStatus,
        governanceDecision,
        isGovernanceViolation,
        commitSha: cleanCommitSha,
        hasDrift,
        healthStatus: observation.health?.status || null,
        syncStatus: observation.sync?.status || null,
        duration: deployment.duration,
        completedAt: deployment.completedAt,
      });
    } catch (pubErr) {
      // Event publication failure must never roll back DB persistence
      logger.error(`Orchestration deployment real-time publish error: ${pubErr.message}`);
    }

    return {
      deployment,
      isNew,
      changed: true,
    };
  }

  /**
   * Get the authoritative deployment delivery projection for an issue.
   *
   * @param {string|mongoose.Types.ObjectId} projectId
   * @param {string} issueKey
   * @returns {Promise<object>}
   */
  static async getIssueDeploymentProjection(projectId, issueKey) {
    const normalizedKey = String(issueKey || '')
      .trim()
      .toUpperCase();

    const emptyProjection = {
      status: 'pending',
      environment: null,
      governanceDecision: DEPLOYMENT_GOVERNANCE_STATE.NOT_EVALUATED,
      isGovernanceViolation: false,
      latestDeployment: null,
    };

    if (!projectId || !normalizedKey) {
      return emptyProjection;
    }

    try {
      // 1. Trace via PipelineRuns matching issueKey
      const matchingRuns = await PipelineRun.find({
        project: projectId,
        matchedIssueKeys: normalizedKey,
      }).select('_id commitSha');

      const pipelineRunIds = matchingRuns.map((r) => r._id);
      const runCommitShas = matchingRuns.map((r) => r.commitSha).filter(Boolean);

      // 2. Trace via Commits matching issueKey
      const matchingCommits = await Commit.find({
        project: projectId,
        matchedIssueKeys: normalizedKey,
      }).select('sha');

      const allCommitShas = Array.from(
        new Set([...runCommitShas, ...matchingCommits.map((c) => c.sha)])
      );

      // 3. Find Deployments linked to matching PipelineRuns or matching CommitShas
      const queryOr = [];
      if (pipelineRunIds.length > 0) {
        queryOr.push({ pipelineRun: { $in: pipelineRunIds } });
      }
      if (allCommitShas.length > 0) {
        queryOr.push({ commitSha: { $in: allCommitShas } });
      }

      if (queryOr.length === 0) {
        return emptyProjection;
      }

      const deployments = await Deployment.find({
        project: projectId,
        $or: queryOr,
      }).sort({ completedAt: -1, createdAt: -1 });

      if (!deployments || deployments.length === 0) {
        return emptyProjection;
      }

      const latest = deployments[0];
      const drift = latest.metadata?.drift || null;
      const orchestration = latest.metadata?.orchestration || null;

      return {
        status:
          latest.status === DEPLOYMENT_STATUS.SUCCESS
            ? 'completed'
            : latest.status === DEPLOYMENT_STATUS.FAILED ||
                latest.status === DEPLOYMENT_STATUS.CANCELLED
              ? 'failed'
              : latest.status === DEPLOYMENT_STATUS.IN_PROGRESS
                ? 'active'
                : 'pending',
        environment: latest.environment,
        governanceDecision: latest.governanceDecision,
        isGovernanceViolation: latest.isGovernanceViolation,
        hasDrift: Boolean(drift?.hasDrift),
        healthStatus: orchestration?.healthStatus || null,
        syncStatus: orchestration?.syncStatus || null,
        drift,
        latestDeployment: {
          _id: latest._id,
          provider: latest.provider,
          environment: latest.environment,
          externalDeploymentId: latest.externalDeploymentId,
          status: latest.status,
          commitSha: latest.commitSha,
          branch: latest.branch,
          url: latest.url,
          actor: latest.actor,
          governanceDecision: latest.governanceDecision,
          isGovernanceViolation: latest.isGovernanceViolation,
          startedAt: latest.startedAt,
          completedAt: latest.completedAt,
          duration: latest.duration,
          errorMessage: latest.errorMessage,
          drift,
          orchestration,
        },
      };
    } catch (err) {
      logger.error(`DeploymentService.getIssueDeploymentProjection error: ${err.message}`);
      return emptyProjection;
    }
  }

  /**
   * List deployments for a project with pagination and environment filtering.
   */
  static async listDeployments(projectId, query = {}) {
    const filter = { project: projectId };
    if (query.environment) {
      filter.environment = String(query.environment).trim().toLowerCase();
    }
    if (query.status) {
      filter.status = query.status;
    }

    const page = parseInt(query.page, 10) || 1;
    const limit = parseInt(query.limit, 10) || 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      Deployment.find(filter).sort({ completedAt: -1, createdAt: -1 }).skip(skip).limit(limit),
      Deployment.countDocuments(filter),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Get single deployment by ID with project isolation check.
   */
  static async getDeploymentById(projectId, deploymentId) {
    if (!mongoose.Types.ObjectId.isValid(deploymentId)) {
      return null;
    }
    return Deployment.findOne({ _id: deploymentId, project: projectId });
  }
}

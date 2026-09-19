import mongoose from 'mongoose';
import GovernancePolicy from './governancePolicy.model.js';
import PolicyGateResult from './policyGateResult.model.js';
import SecurityScan from './securityScan.model.js';
import SecurityFinding from './securityFinding.model.js';
import AuditService from '../audit/audit.service.js';
import {
  POLICY_RULE_TYPE,
  POLICY_ENFORCEMENT,
  POLICY_EVALUATION_STATE,
  SECURITY_SCAN_STATUS,
  SECURITY_FINDING_STATUS,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
} from '../../shared/constants.js';
import logger from '../../shared/logger.js';

/**
 * Governance Policy Engine Service.
 *
 * Evaluates active GovernancePolicy records against completed SecurityScan
 * data and produces deterministic PolicyGateResult records.
 *
 * Supported rule types:
 * - max_severity_count: Count open findings by severity threshold
 * - required_scan: Verify recent qualifying scan exists within age window
 *
 * Aggregate gate state priority:
 * FAIL > WARNING > NOT_EVALUATED > PASS
 *
 * This service does NOT:
 * - Parse Trivy reports
 * - Access BullMQ or Redis
 * - Access Socket.io
 * - Modify SecurityFinding lifecycle
 * - Modify SecurityScan finding data
 */
export default class PolicyEngineService {
  /**
   * Evaluate all active policies for a project against a completed security scan.
   *
   * @param {object} params
   * @param {string|mongoose.Types.ObjectId} params.projectId
   * @param {string|mongoose.Types.ObjectId} params.securityScanId
   * @returns {Promise<{ gateStatus: string, results: Array, scanId: string }>}
   */
  static async evaluatePolicies({ projectId, securityScanId }) {
    // 1. Load and validate the scan
    const scan = await SecurityScan.findOne({
      _id: securityScanId,
      project: projectId,
    });

    if (!scan) {
      throw new Error(
        `SecurityScan ${securityScanId} not found or does not belong to project ${projectId}`
      );
    }

    if (scan.status !== SECURITY_SCAN_STATUS.COMPLETED) {
      throw new Error(
        `SecurityScan ${securityScanId} is not completed (status: ${scan.status}). Policy evaluation requires a completed scan.`
      );
    }

    // 2. Load active policies for the project
    const policies = await GovernancePolicy.find({
      project: projectId,
      isActive: true,
    });

    if (policies.length === 0) {
      // No active policies: gate status is PASS by default
      await SecurityScan.updateOne(
        { _id: scan._id },
        { $set: { gateStatus: POLICY_EVALUATION_STATE.PASS } }
      );

      return {
        gateStatus: POLICY_EVALUATION_STATE.PASS,
        results: [],
        scanId: scan._id,
      };
    }

    // 3. Evaluate each policy
    const results = [];

    for (const policy of policies) {
      let evaluation;

      try {
        if (policy.ruleType === POLICY_RULE_TYPE.MAX_SEVERITY_COUNT) {
          evaluation = await PolicyEngineService._evaluateMaxSeverityCount(scan, policy);
        } else if (policy.ruleType === POLICY_RULE_TYPE.REQUIRED_SCAN) {
          evaluation = await PolicyEngineService._evaluateRequiredScan(scan, policy);
        } else {
          evaluation = {
            passed: false,
            evaluationStatus: POLICY_EVALUATION_STATE.NOT_EVALUATED,
            reason: `Unsupported rule type: ${policy.ruleType}`,
            evaluatedData: { ruleType: policy.ruleType },
            isError: true,
          };
        }
      } catch (evalErr) {
        // System/evaluation error — NOT a policy violation
        logger.error(
          `Policy evaluation error for policy ${policy._id} (${policy.name}): ${evalErr.message}`
        );
        evaluation = {
          passed: false,
          evaluationStatus: POLICY_EVALUATION_STATE.NOT_EVALUATED,
          reason: `Evaluation error: ${evalErr.message?.substring(0, 200)}`,
          evaluatedData: { error: evalErr.message?.substring(0, 200) },
          isError: true,
        };
      }

      // Apply enforcement semantics
      // NOT_EVALUATED stays NOT_EVALUATED regardless of enforcement — insufficient data
      // is not a policy violation and must not be masked as FAIL.
      let finalStatus = evaluation.evaluationStatus;
      if (
        !evaluation.isError &&
        evaluation.evaluationStatus !== POLICY_EVALUATION_STATE.NOT_EVALUATED
      ) {
        if (evaluation.passed) {
          finalStatus = POLICY_EVALUATION_STATE.PASS;
        } else if (policy.enforcement === POLICY_ENFORCEMENT.WARNING) {
          finalStatus = POLICY_EVALUATION_STATE.WARNING;
        } else {
          // blocking enforcement
          finalStatus = POLICY_EVALUATION_STATE.FAIL;
        }
      }

      // 4. Upsert PolicyGateResult (idempotent: unique on scan + policy)
      const gateResult = await PolicyGateResult.findOneAndUpdate(
        {
          scan: scan._id,
          policy: policy._id,
        },
        {
          $set: {
            project: projectId,
            pipelineRun: scan.pipelineRun || null,
            policyName: policy.name,
            ruleType: policy.ruleType,
            enforcement: policy.enforcement,
            passed: evaluation.passed,
            evaluationStatus: finalStatus,
            reason: evaluation.reason,
            evaluatedData: evaluation.evaluatedData || {},
            originalGateState: {
              passed: evaluation.passed,
              evaluationStatus: finalStatus,
              reason: evaluation.reason,
            },
          },
          $setOnInsert: {
            isOverridden: false,
            overrideStatus: null,
            overriddenBy: null,
            overriddenAt: null,
            overrideJustification: '',
          },
        },
        { upsert: true, new: true }
      );

      results.push(gateResult);
    }

    // 5. Compute deterministic aggregate gate status
    const gateStatus = PolicyEngineService._computeAggregateGateStatus(results);

    // 6. Update SecurityScan gateStatus
    await SecurityScan.updateOne({ _id: scan._id }, { $set: { gateStatus } });

    // 7. Audit log
    await AuditService.log({
      action: AUDIT_ACTIONS.POLICY_GATE_EVALUATED,
      entityType: ENTITY_TYPES.SECURITY_SCAN,
      entityId: scan._id,
      projectId,
      metadata: {
        gateStatus,
        policiesEvaluated: results.length,
        results: results.map((r) => ({
          policyName: r.policyName,
          ruleType: r.ruleType,
          enforcement: r.enforcement,
          passed: r.passed,
          evaluationStatus: r.evaluationStatus,
        })),
      },
    });

    logger.info(
      `Policy evaluation for scan ${scan._id}: gateStatus=${gateStatus}, ` +
        `policies=${results.length}`
    );

    return {
      gateStatus,
      results,
      scanId: scan._id,
    };
  }

  /**
   * Evaluate a max_severity_count policy.
   *
   * Counts open findings in the scan matching the configured severity.
   * Only counts findings with status === 'open'.
   * Does NOT count: resolved, false_positive, acknowledged.
   *
   * @param {object} scan - SecurityScan document
   * @param {object} policy - GovernancePolicy document
   * @returns {{ passed: boolean, evaluationStatus: string, reason: string, evaluatedData: object }}
   */
  static async _evaluateMaxSeverityCount(scan, policy) {
    const { severity, maxCount } = policy.ruleConfig;

    if (!severity || typeof maxCount !== 'number' || maxCount < 0) {
      return {
        passed: false,
        evaluationStatus: POLICY_EVALUATION_STATE.NOT_EVALUATED,
        reason: `Invalid ruleConfig: severity=${severity}, maxCount=${maxCount}`,
        evaluatedData: { severity, maxCount, error: 'Invalid ruleConfig' },
        isError: true,
      };
    }

    const actualCount = await SecurityFinding.countDocuments({
      scan: scan._id,
      severity,
      status: SECURITY_FINDING_STATUS.OPEN,
    });

    const passed = actualCount <= maxCount;

    return {
      passed,
      evaluationStatus: passed ? POLICY_EVALUATION_STATE.PASS : POLICY_EVALUATION_STATE.FAIL,
      reason: passed
        ? `${severity} findings (${actualCount}) within threshold (max: ${maxCount})`
        : `${severity} findings (${actualCount}) exceed threshold (max: ${maxCount})`,
      evaluatedData: {
        severity,
        maxCount,
        actualCount,
      },
      isError: false,
    };
  }

  /**
   * Evaluate a required_scan policy.
   *
   * Checks whether a qualifying completed SecurityScan exists within
   * the configured age window for the matching scope.
   *
   * Qualifying scope: project + repository + provider + scanType
   * (using the current scan's repository for scoping)
   *
   * Semantics:
   * - Recent completed qualifying scan → PASS
   * - No qualifying scan at all → NOT_EVALUATED
   * - Only processing/pending scans → NOT_EVALUATED
   * - Only failed scans → NOT_EVALUATED
   * - Scan exists but older than maxAge → FAIL
   *
   * @param {object} scan - SecurityScan document (the current scan being evaluated)
   * @param {object} policy - GovernancePolicy document
   * @returns {{ passed: boolean, evaluationStatus: string, reason: string, evaluatedData: object }}
   */
  static async _evaluateRequiredScan(scan, policy) {
    const { provider, scanType, maxAgeSeconds } = policy.ruleConfig;

    if (!scanType || typeof maxAgeSeconds !== 'number' || maxAgeSeconds <= 0) {
      return {
        passed: false,
        evaluationStatus: POLICY_EVALUATION_STATE.NOT_EVALUATED,
        reason: `Invalid ruleConfig: scanType=${scanType}, maxAgeSeconds=${maxAgeSeconds}`,
        evaluatedData: { provider, scanType, maxAgeSeconds, error: 'Invalid ruleConfig' },
        isError: true,
      };
    }

    // Build scope filter
    const scopeFilter = {
      project: scan.project,
      scanType,
      status: SECURITY_SCAN_STATUS.COMPLETED,
    };

    // Provider filter (optional: if not specified, any provider qualifies)
    if (provider) {
      scopeFilter.provider = provider;
    }

    // Repository scoping: use the current scan's repository if available
    if (scan.repository) {
      scopeFilter.repository = scan.repository;
    }

    // Find the most recent completed qualifying scan
    const latestQualifyingScan = await SecurityScan.findOne(scopeFilter).sort({
      completedAt: -1,
    });

    const maxAgeHours = maxAgeSeconds / 3600;

    if (!latestQualifyingScan) {
      return {
        passed: false,
        evaluationStatus: POLICY_EVALUATION_STATE.NOT_EVALUATED,
        reason: `No completed ${scanType} scan found${provider ? ` from provider '${provider}'` : ''}`,
        evaluatedData: {
          provider: provider || 'any',
          scanType,
          maxAgeHours,
          maxAgeSeconds,
          qualifyingScanFound: false,
          scanAgeHours: null,
        },
        isError: false,
      };
    }

    // Calculate age
    const scanCompletedAt = latestQualifyingScan.completedAt || latestQualifyingScan.createdAt;
    const ageMs = Date.now() - scanCompletedAt.getTime();
    const ageSeconds = ageMs / 1000;
    const ageHours = ageSeconds / 3600;

    if (ageSeconds > maxAgeSeconds) {
      return {
        passed: false,
        evaluationStatus: POLICY_EVALUATION_STATE.FAIL,
        reason: `Most recent ${scanType} scan is ${ageHours.toFixed(1)}h old, exceeds max age of ${maxAgeHours.toFixed(1)}h`,
        evaluatedData: {
          provider: provider || 'any',
          scanType,
          maxAgeHours,
          maxAgeSeconds,
          qualifyingScanFound: true,
          scanAgeHours: parseFloat(ageHours.toFixed(2)),
          qualifyingScanId: latestQualifyingScan._id,
        },
        isError: false,
      };
    }

    return {
      passed: true,
      evaluationStatus: POLICY_EVALUATION_STATE.PASS,
      reason: `Recent ${scanType} scan found (${ageHours.toFixed(1)}h old, max: ${maxAgeHours.toFixed(1)}h)`,
      evaluatedData: {
        provider: provider || 'any',
        scanType,
        maxAgeHours,
        maxAgeSeconds,
        qualifyingScanFound: true,
        scanAgeHours: parseFloat(ageHours.toFixed(2)),
        qualifyingScanId: latestQualifyingScan._id,
      },
      isError: false,
    };
  }

  /**
   * Compute deterministic aggregate gate status from individual results.
   *
   * Priority: FAIL > WARNING > NOT_EVALUATED > PASS
   *
   * - FAIL: any applicable blocking policy fails
   * - WARNING: no blocking FAIL, but at least one warning violation
   * - NOT_EVALUATED: no FAIL/WARNING but one or more policies cannot be evaluated
   * - PASS: all applicable policies pass
   *
   * @param {Array} results - PolicyGateResult documents
   * @returns {string} Aggregate gate status
   */
  static _computeAggregateGateStatus(results) {
    if (results.length === 0) {
      return POLICY_EVALUATION_STATE.PASS;
    }

    let hasFail = false;
    let hasWarning = false;
    let hasNotEvaluated = false;

    for (const result of results) {
      const status = result.evaluationStatus;

      if (status === POLICY_EVALUATION_STATE.FAIL) {
        hasFail = true;
      } else if (status === POLICY_EVALUATION_STATE.WARNING) {
        hasWarning = true;
      } else if (status === POLICY_EVALUATION_STATE.NOT_EVALUATED) {
        hasNotEvaluated = true;
      }
    }

    if (hasFail) return POLICY_EVALUATION_STATE.FAIL;
    if (hasWarning) return POLICY_EVALUATION_STATE.WARNING;
    if (hasNotEvaluated) return POLICY_EVALUATION_STATE.NOT_EVALUATED;
    return POLICY_EVALUATION_STATE.PASS;
  }

  /**
   * Non-destructive manual override of a PolicyGateResult.
   *
   * Preserves the original evaluation (passed, evaluationStatus, reason).
   * Records override metadata without rewriting the security assessment.
   *
   * Authorization: Platform role (admin/security) AND Project role (owner/admin)
   * must be validated by the caller before invoking this method.
   *
   * @param {object} params
   * @param {string|mongoose.Types.ObjectId} params.gateResultId
   * @param {string|mongoose.Types.ObjectId} params.actorId
   * @param {string|mongoose.Types.ObjectId} params.projectId
   * @param {string} params.justification
   * @returns {Promise<object>} Updated PolicyGateResult
   */
  static async overridePolicyGate({ gateResultId, actorId, projectId, justification }) {
    if (!justification || typeof justification !== 'string' || justification.trim().length < 10) {
      throw new Error('Override justification is required and must be at least 10 characters');
    }

    if (!mongoose.Types.ObjectId.isValid(gateResultId)) {
      throw new Error('Invalid gateResultId format');
    }

    // Load the gate result and verify project ownership
    const gateResult = await PolicyGateResult.findOne({
      _id: gateResultId,
      project: projectId,
    });

    if (!gateResult) {
      throw new Error(
        `PolicyGateResult ${gateResultId} not found or does not belong to project ${projectId}`
      );
    }

    if (gateResult.isOverridden) {
      throw new Error('This policy gate result has already been overridden');
    }

    // Non-destructive override: preserve original evaluation
    const updated = await PolicyGateResult.findByIdAndUpdate(
      gateResult._id,
      {
        $set: {
          isOverridden: true,
          overrideStatus: 'approved',
          overriddenBy: actorId,
          overriddenAt: new Date(),
          overrideJustification: justification.trim(),
        },
      },
      { new: true }
    );

    // Audit the override
    await AuditService.log({
      action: AUDIT_ACTIONS.POLICY_GATE_OVERRIDDEN,
      actor: actorId,
      entityType: ENTITY_TYPES.POLICY_GATE_RESULT,
      entityId: gateResult._id,
      projectId,
      metadata: {
        policyName: gateResult.policyName,
        ruleType: gateResult.ruleType,
        originalPassed: gateResult.passed,
        originalEvaluationStatus: gateResult.evaluationStatus,
        originalReason: gateResult.reason,
        overrideJustification: justification.trim(),
      },
    });

    logger.info(
      `Policy gate override: result=${gateResult._id}, policy=${gateResult.policyName}, ` +
        `originalStatus=${gateResult.evaluationStatus}, actor=${actorId}`
    );

    return updated;
  }
}

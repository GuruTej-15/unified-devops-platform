import PipelineRun from '../cicd/pipelineRun.model.js';
import SecurityScan from './securityScan.model.js';
import PolicyGateResult from './policyGateResult.model.js';
import {
  SECURITY_SCAN_STATUS,
  SECURITY_DELIVERY_STATUS,
  POLICY_EVALUATION_STATE,
  POLICY_ENFORCEMENT,
} from '../../shared/constants.js';
import logger from '../../shared/logger.js';

/**
 * Authoritative Security and Governance Delivery State Projection Service.
 *
 * Resolves unified security and governance delivery state for issues using
 * the approved traceability path:
 * SecurityScan → PipelineRun → matchedIssueKeys → Issue
 *
 * State Derivation:
 * - No relevant scan: NOT_STARTED
 * - Latest scan processing/pending: PROCESSING
 * - Latest scan failed: ERROR
 * - Completed scan with blocking policy failure: FAILED
 * - Completed scan with warning-only governance: PASSED (with gateStatus: WARNING)
 * - Completed scan with passing policies: PASSED
 * - Completed scan with insufficient policy data: NOT_EVALUATED
 * - System/evaluation error: ERROR
 */
export default class SecurityDeliveryStateService {
  /**
   * Get the authoritative security & governance delivery projection for an issue.
   *
   * @param {string|mongoose.Types.ObjectId} projectId
   * @param {string} issueKey - e.g. 'PAY-101'
   * @returns {Promise<{ security: object, governance: object, traceability: object }>}
   */
  static async getIssueSecurityProjection(projectId, issueKey) {
    const normalizedKey = String(issueKey || '')
      .trim()
      .toUpperCase();

    const emptyProjection = {
      security: {
        status: SECURITY_DELIVERY_STATUS.NOT_STARTED,
        scanStatus: null,
        latestScan: null,
        findingsSummary: null,
        gateStatus: null,
        lastEvaluatedAt: null,
      },
      governance: {
        status: POLICY_EVALUATION_STATE.NOT_EVALUATED,
        blockingFailures: 0,
        warnings: 0,
        notEvaluated: 0,
        passed: 0,
        overridden: false,
        overrideCount: 0,
        policies: [],
      },
      traceability: {
        matchedPipelineRuns: 0,
        associatedScanId: null,
      },
    };

    if (!projectId || !normalizedKey) {
      return emptyProjection;
    }

    try {
      // 1. Traceability: Find PipelineRuns linked to this issueKey
      const pipelineRuns = await PipelineRun.find({
        project: projectId,
        matchedIssueKeys: normalizedKey,
      }).sort({ startedAt: -1, createdAt: -1 });

      if (!pipelineRuns || pipelineRuns.length === 0) {
        return emptyProjection;
      }

      const pipelineRunIds = pipelineRuns.map((r) => r._id);

      // 2. Traceability: Find SecurityScans attached to these PipelineRuns
      // (SecurityScan has no direct issueKey; traceability is strictly via pipelineRun)
      const scans = await SecurityScan.find({
        project: projectId,
        pipelineRun: { $in: pipelineRunIds },
      }).sort({ createdAt: -1 });

      if (!scans || scans.length === 0) {
        return {
          ...emptyProjection,
          traceability: {
            matchedPipelineRuns: pipelineRuns.length,
            associatedScanId: null,
          },
        };
      }

      // 3. Select the latest relevant scan
      const latestScan = scans[0];

      return SecurityDeliveryStateService.projectScanSecurityState(latestScan, pipelineRuns.length);
    } catch (err) {
      logger.error(
        `SecurityDeliveryStateService error for project=${projectId}, issue=${normalizedKey}: ${err.message}`
      );
      return {
        security: {
          status: SECURITY_DELIVERY_STATUS.ERROR,
          scanStatus: null,
          latestScan: null,
          findingsSummary: null,
          gateStatus: null,
          lastEvaluatedAt: null,
          error: err.message,
        },
        governance: {
          status: POLICY_EVALUATION_STATE.NOT_EVALUATED,
          blockingFailures: 0,
          warnings: 0,
          notEvaluated: 0,
          passed: 0,
          overridden: false,
          overrideCount: 0,
          policies: [],
        },
        traceability: {
          matchedPipelineRuns: 0,
          associatedScanId: null,
        },
      };
    }
  }

  /**
   * Project security and governance delivery state from an authoritative SecurityScan document.
   *
   * @param {object} scan - SecurityScan document
   * @param {number} [matchedPipelineRuns=1] - Number of pipeline runs matched for traceability
   * @returns {Promise<{ security: object, governance: object, traceability: object }>}
   */
  static async projectScanSecurityState(scan, matchedPipelineRuns = 1) {
    if (!scan) {
      return {
        security: {
          status: SECURITY_DELIVERY_STATUS.NOT_STARTED,
          scanStatus: null,
          latestScan: null,
          findingsSummary: null,
          gateStatus: null,
          lastEvaluatedAt: null,
        },
        governance: {
          status: POLICY_EVALUATION_STATE.NOT_EVALUATED,
          blockingFailures: 0,
          warnings: 0,
          notEvaluated: 0,
          passed: 0,
          overridden: false,
          overrideCount: 0,
          policies: [],
        },
        traceability: {
          matchedPipelineRuns,
          associatedScanId: null,
        },
      };
    }

    const sanitizedScan = {
      _id: scan._id,
      provider: scan.provider,
      scanType: scan.scanType,
      target: scan.target,
      status: scan.status,
      findingCount: scan.findingCount ?? 0,
      startedAt: scan.startedAt,
      completedAt: scan.completedAt,
      duration: scan.duration,
      pipelineRun: scan.pipelineRun,
      commitSha: scan.commitSha,
      branch: scan.branch,
    };

    // Case A: Scan is still processing or pending
    if (
      scan.status === SECURITY_SCAN_STATUS.PROCESSING ||
      scan.status === SECURITY_SCAN_STATUS.PENDING
    ) {
      return {
        security: {
          status: SECURITY_DELIVERY_STATUS.PROCESSING,
          scanStatus: scan.status,
          latestScan: sanitizedScan,
          findingsSummary: scan.summary || null,
          gateStatus: null,
          lastEvaluatedAt: null,
        },
        governance: {
          status: POLICY_EVALUATION_STATE.NOT_EVALUATED,
          blockingFailures: 0,
          warnings: 0,
          notEvaluated: 0,
          passed: 0,
          overridden: false,
          overrideCount: 0,
          policies: [],
        },
        traceability: {
          matchedPipelineRuns,
          associatedScanId: scan._id,
        },
      };
    }

    // Case B: Scan failed execution (infrastructure / parsing error)
    if (scan.status === SECURITY_SCAN_STATUS.FAILED) {
      return {
        security: {
          status: SECURITY_DELIVERY_STATUS.ERROR,
          scanStatus: scan.status,
          latestScan: {
            ...sanitizedScan,
            errorMessage: scan.errorMessage || 'Scan execution failed',
          },
          findingsSummary: scan.summary || null,
          gateStatus: null,
          lastEvaluatedAt: scan.completedAt || scan.updatedAt,
        },
        governance: {
          status: POLICY_EVALUATION_STATE.NOT_EVALUATED,
          blockingFailures: 0,
          warnings: 0,
          notEvaluated: 0,
          passed: 0,
          overridden: false,
          overrideCount: 0,
          policies: [],
        },
        traceability: {
          matchedPipelineRuns,
          associatedScanId: scan._id,
        },
      };
    }

    // Case C: Scan is completed — evaluate governance PolicyGateResult records
    const policyResults = await PolicyGateResult.find({ scan: scan._id }).sort({
      createdAt: 1,
    });

    let blockingFailures = 0;
    let warnings = 0;
    let notEvaluated = 0;
    let passed = 0;
    let overrideCount = 0;
    let hasEvaluationError = false;

    const formattedPolicies = policyResults.map((r) => {
      if (r.isOverridden) {
        overrideCount++;
      }

      if (r.evaluationStatus === POLICY_EVALUATION_STATE.FAIL) {
        if (r.enforcement === POLICY_ENFORCEMENT.BLOCKING) {
          blockingFailures++;
        } else {
          warnings++;
        }
      } else if (r.evaluationStatus === POLICY_EVALUATION_STATE.WARNING) {
        warnings++;
      } else if (r.evaluationStatus === POLICY_EVALUATION_STATE.NOT_EVALUATED) {
        notEvaluated++;
        if (r.evaluatedData?.error) {
          hasEvaluationError = true;
        }
      } else if (r.evaluationStatus === POLICY_EVALUATION_STATE.PASS) {
        passed++;
      }

      return {
        policyId: r.policy,
        policyName: r.policyName,
        ruleType: r.ruleType,
        enforcement: r.enforcement,
        passed: r.passed,
        evaluationStatus: r.evaluationStatus,
        reason: r.reason,
        evaluatedData: r.evaluatedData,
        isOverridden: r.isOverridden,
        overrideStatus: r.overrideStatus,
        overrideJustification: r.overrideJustification,
        overriddenBy: r.overriddenBy,
        overriddenAt: r.overriddenAt,
      };
    });

    // Authoritative aggregate governance status:
    // Prefer authoritative scan.gateStatus, or compute using FAIL > WARNING > NOT_EVALUATED > PASS
    let governanceStatus = scan.gateStatus;
    if (!governanceStatus) {
      if (blockingFailures > 0) {
        governanceStatus = POLICY_EVALUATION_STATE.FAIL;
      } else if (warnings > 0) {
        governanceStatus = POLICY_EVALUATION_STATE.WARNING;
      } else if (notEvaluated > 0) {
        governanceStatus = POLICY_EVALUATION_STATE.NOT_EVALUATED;
      } else {
        governanceStatus = POLICY_EVALUATION_STATE.PASS;
      }
    }

    // Determine deterministic security delivery status
    let securityStatus;
    if (hasEvaluationError) {
      securityStatus = SECURITY_DELIVERY_STATUS.ERROR;
    } else if (governanceStatus === POLICY_EVALUATION_STATE.FAIL) {
      securityStatus = SECURITY_DELIVERY_STATUS.FAILED;
    } else if (governanceStatus === POLICY_EVALUATION_STATE.WARNING) {
      // Warning-only policies: scan completed and passed blocking gates
      securityStatus = SECURITY_DELIVERY_STATUS.PASSED;
    } else if (governanceStatus === POLICY_EVALUATION_STATE.NOT_EVALUATED) {
      securityStatus = SECURITY_DELIVERY_STATUS.NOT_EVALUATED;
    } else if (governanceStatus === POLICY_EVALUATION_STATE.PASS) {
      securityStatus = SECURITY_DELIVERY_STATUS.PASSED;
    } else {
      securityStatus = SECURITY_DELIVERY_STATUS.NOT_EVALUATED;
    }

    const isFullyOverridden =
      blockingFailures > 0 &&
      overrideCount > 0 &&
      policyResults
        .filter((r) => r.evaluationStatus === POLICY_EVALUATION_STATE.FAIL)
        .every((r) => r.isOverridden);

    return {
      security: {
        status: securityStatus,
        scanStatus: scan.status,
        latestScan: sanitizedScan,
        findingsSummary: scan.summary || {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          negligible: 0,
          unknown: 0,
          total: 0,
        },
        gateStatus: governanceStatus,
        isOverridden: overrideCount > 0,
        isFullyOverridden,
        lastEvaluatedAt: scan.completedAt || scan.updatedAt,
      },
      governance: {
        status: governanceStatus,
        blockingFailures,
        warnings,
        notEvaluated,
        passed,
        overridden: overrideCount > 0,
        overrideCount,
        isFullyOverridden,
        policies: formattedPolicies,
      },
      traceability: {
        matchedPipelineRuns,
        associatedScanId: scan._id,
      },
    };
  }
}

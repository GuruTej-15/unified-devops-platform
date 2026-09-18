import SecurityFinding from './securityFinding.model.js';
import SecurityScan from './securityScan.model.js';
import { SECURITY_FINDING_STATUS, SECURITY_SCAN_STATUS } from '../../shared/constants.js';
import logger from '../../shared/logger.js';

/**
 * Security Finding Reconciliation Service.
 *
 * Reconciles finding lifecycle state across successive scans of the
 * same comparable scope (repository + target + provider + scanType).
 *
 * Comparable scope is defined at the SCAN level, not at the finding level.
 * Findings within a scan may have per-result targets that differ from the
 * scan-level target (e.g. Trivy ArtifactName vs Result.Target).
 *
 * Reconciliation rules:
 * 1. `open` findings absent from newer scan → `resolved`
 * 2. `acknowledged` remains `acknowledged` (NEVER auto-resolved)
 * 3. `false_positive` remains `false_positive` (NEVER auto-resolved)
 * 4. Previously auto-resolved finding re-detected → `open`
 * 5. Previously `acknowledged` finding re-detected → stays `acknowledged`
 * 6. Previously `false_positive` finding re-detected → stays `false_positive`
 * 7. First-ever scan for a scope: no reconciliation needed
 */
export default class SecurityReconciliationService {
  /**
   * Reconcile findings after a new scan completes.
   *
   * Uses a two-step approach:
   * 1. Find previous SecurityScan documents with matching comparable scope
   * 2. Find all SecurityFinding documents from those previous scans
   * 3. Compare identity keys against the current scan's findings
   *
   * @param {object} params
   * @param {mongoose.Types.ObjectId} params.scanId - The newly completed scan
   * @param {mongoose.Types.ObjectId} params.projectId
   * @param {mongoose.Types.ObjectId|null} params.repositoryId
   * @param {string} params.target - Scan-level target (e.g. 'alpine:3.18.4')
   * @param {string} params.provider - e.g. 'trivy'
   * @param {string} params.scanType - e.g. 'image', 'filesystem'
   * @param {string[]} params.currentIdentityKeys - Identity keys from current scan findings
   * @param {object} [params.session] - Optional MongoDB session for transaction
   * @returns {Promise<{ resolved: number, reopened: number, preserved: number }>}
   */
  static async reconcileFindings({
    scanId,
    projectId,
    repositoryId,
    target,
    provider,
    scanType,
    currentIdentityKeys,
    session = null,
  }) {
    const stats = { resolved: 0, reopened: 0, preserved: 0 };
    const queryOpts = session ? { session } : {};

    // Step 1: Find previous scans in the comparable scope (excluding current scan)
    const scanScopeFilter = {
      project: projectId,
      target,
      provider,
      scanType,
      _id: { $ne: scanId },
      status: { $in: [SECURITY_SCAN_STATUS.COMPLETED, SECURITY_SCAN_STATUS.PROCESSING] },
    };

    if (repositoryId) {
      scanScopeFilter.repository = repositoryId;
    }

    const previousScans = await SecurityScan.find(scanScopeFilter, { _id: 1 }, queryOpts);

    if (previousScans.length === 0) {
      // First-ever scan for this scope: nothing to reconcile
      logger.info(
        `Reconciliation: first scan for scope (project=${projectId}, target=${target}, provider=${provider}). No reconciliation needed.`
      );
      return stats;
    }

    const previousScanIds = previousScans.map((s) => s._id);

    // Step 2: Get all findings from previous scans
    const previousFindings = await SecurityFinding.find(
      { scan: { $in: previousScanIds } },
      null,
      queryOpts
    ).sort({ createdAt: -1 });

    if (previousFindings.length === 0) {
      logger.info(
        `Reconciliation: previous scans exist but contain no findings (project=${projectId}, target=${target}). No reconciliation needed.`
      );
      return stats;
    }

    // Build a Set of current scan identity keys for O(1) lookup
    const currentKeySet = new Set(currentIdentityKeys);

    // Track identity keys we've already processed to avoid acting on duplicates
    // (multiple prior findings with same identity key from different historic scans)
    const processedKeys = new Set();

    for (const finding of previousFindings) {
      const key = finding.findingIdentityKey;

      // Skip if we already processed a more recent finding with this identity key
      if (processedKeys.has(key)) {
        continue;
      }
      processedKeys.add(key);

      const isStillPresent = currentKeySet.has(key);

      if (!isStillPresent) {
        // Finding is absent from current scan
        if (finding.status === SECURITY_FINDING_STATUS.OPEN) {
          // Rule 1: open → resolved
          await SecurityFinding.updateOne(
            { _id: finding._id },
            {
              $set: {
                status: SECURITY_FINDING_STATUS.RESOLVED,
                resolvedAt: new Date(),
              },
            },
            queryOpts
          );
          stats.resolved++;
        } else if (
          finding.status === SECURITY_FINDING_STATUS.ACKNOWLEDGED ||
          finding.status === SECURITY_FINDING_STATUS.FALSE_POSITIVE
        ) {
          // Rules 2 & 3: acknowledged and false_positive are NEVER auto-resolved
          stats.preserved++;
        }
        // Already resolved findings: no action needed
      } else {
        // Finding is still present in current scan
        if (finding.status === SECURITY_FINDING_STATUS.RESOLVED) {
          // Rule 4: previously auto-resolved, now re-detected → open
          await SecurityFinding.updateOne(
            { _id: finding._id },
            {
              $set: {
                status: SECURITY_FINDING_STATUS.OPEN,
                resolvedAt: null,
              },
            },
            queryOpts
          );
          stats.reopened++;
        } else if (
          finding.status === SECURITY_FINDING_STATUS.ACKNOWLEDGED ||
          finding.status === SECURITY_FINDING_STATUS.FALSE_POSITIVE
        ) {
          // Rules 5 & 6: acknowledged/false_positive re-detected → stays as-is
          stats.preserved++;
        }
        // Open findings still present: no action needed
      }
    }

    logger.info(
      `Reconciliation complete for scan ${scanId}: resolved=${stats.resolved}, reopened=${stats.reopened}, preserved=${stats.preserved}`
    );

    return stats;
  }
}

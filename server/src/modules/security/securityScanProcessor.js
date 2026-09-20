import mongoose from 'mongoose';
import SecurityScan from './securityScan.model.js';
import SecurityFinding from './securityFinding.model.js';
import SecurityDelivery from './securityDelivery.model.js';
import { getSecurityProvider } from './providers/securityProviderRegistry.js';
import SecurityReconciliationService from './securityReconciliation.service.js';
import AuditService from '../audit/audit.service.js';
import PolicyEngineService from './policyEngine.service.js';
import { publishSecurityEvent } from '../cicd/events/ciEventBridge.js';
import {
  SECURITY_SCAN_STATUS,
  SECURITY_FINDING_STATUS,
  SECURITY_EVENTS,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
} from '../../shared/constants.js';
import logger from '../../shared/logger.js';

/**
 * Process a security scan ingestion job from BullMQ.
 *
 * Processing flow:
 * 1. SecurityDelivery state: queued → processing
 * 2. Idempotency check: skip if scan already exists for this reportDigest+integration
 * 3. Provider dispatch via SecurityProviderRegistry
 * 4. TrivyProvider.parseReport() → normalized findings + summary
 * 5. MongoDB transaction:
 *    a. Create SecurityScan (processing → completed)
 *    b. Bulk insert SecurityFinding[] records
 *    c. Finding lifecycle reconciliation
 *    d. Update SecurityScan with summary + findingCount
 * 6. SecurityDelivery state: processing → processed
 * 7. Audit log for terminal events
 *
 * @param {object} jobData - BullMQ job data from securityQueue.js
 * @returns {Promise<object>} Processing result
 */
export async function processSecurityScanJob(jobData) {
  const {
    securityIntegrationId,
    projectId,
    repositoryId,
    pipelineRunId,
    commitSha,
    branch,
    target: jobTarget,
    scanType: jobScanType,
    provider: providerName,
    reportDigest,
    rawPayload,
  } = jobData;

  const logPrefix = `[SecurityScan ${reportDigest?.substring(0, 12)}...]`;
  let scan = null;

  // 1. Transition SecurityDelivery: queued → processing
  await SecurityDelivery.findOneAndUpdate(
    {
      integration: securityIntegrationId,
      reportDigest,
      status: { $in: ['claimed', 'queued'] },
    },
    { $set: { status: 'processing' } }
  );

  // Publish security.scan.processing event (safe: non-blocking)
  try {
    await publishSecurityEvent(SECURITY_EVENTS.SCAN_PROCESSING, {
      projectId: String(projectId),
      pipelineRunId: pipelineRunId ? String(pipelineRunId) : null,
      reportDigest,
      provider: providerName,
      status: 'processing',
    });
  } catch (pubErr) {
    logger.warn(`${logPrefix} Failed to publish processing event: ${pubErr.message}`);
  }

  try {
    // 2. Idempotency: check if a scan already exists for this integration+reportDigest
    const existingScan = await SecurityScan.findOne({
      securityIntegration: securityIntegrationId,
      reportDigest,
      status: { $in: [SECURITY_SCAN_STATUS.COMPLETED, SECURITY_SCAN_STATUS.PROCESSING] },
    });

    if (existingScan) {
      logger.info(
        `${logPrefix} Scan already exists (id=${existingScan._id}, status=${existingScan.status}). Skipping duplicate processing.`
      );

      // Ensure delivery is marked processed
      await SecurityDelivery.findOneAndUpdate(
        { integration: securityIntegrationId, reportDigest },
        { $set: { status: 'processed' } }
      );

      return {
        success: true,
        duplicate: true,
        scanId: existingScan._id,
        status: existingScan.status,
      };
    }

    // 3. Provider dispatch via registry
    const providerAdapter = getSecurityProvider(providerName);

    // 4. Parse report via provider
    const rawReport = rawPayload?.report || rawPayload;
    const context = {
      repositoryId: repositoryId || null,
      projectId,
      scanType: jobScanType,
      target: jobTarget,
    };

    const {
      findings: normalizedFindings,
      summary,
      providerMetadata,
    } = providerAdapter.parseReport(rawReport, context);

    // Extract scan metadata for target/scanType if not provided in job
    const scanMetadata = providerAdapter.extractScanMetadata(rawReport, context);
    const finalTarget = jobTarget || scanMetadata.target || 'unknown-target';
    const finalScanType = jobScanType || scanMetadata.scanType || 'filesystem';

    // 5. MongoDB transaction: scan creation + finding persistence + reconciliation
    const session = await mongoose.startSession();
    let reconciliationStats = { resolved: 0, reopened: 0, preserved: 0 };

    try {
      await session.withTransaction(async () => {
        // 5a. Create SecurityScan in processing state
        const [createdScan] = await SecurityScan.create(
          [
            {
              project: projectId,
              repository: repositoryId || null,
              pipelineRun: pipelineRunId || null,
              securityIntegration: securityIntegrationId,
              provider: providerName,
              scanType: finalScanType,
              target: finalTarget,
              commitSha: commitSha || '',
              branch: branch || '',
              status: SECURITY_SCAN_STATUS.PROCESSING,
              reportDigest,
              providerMetadata: providerMetadata || {},
              startedAt: new Date(),
            },
          ],
          { session }
        );

        scan = createdScan;

        // 5b. Bulk insert SecurityFinding[] records
        if (normalizedFindings.length > 0) {
          const findingDocs = normalizedFindings.map((f) => ({
            project: projectId,
            repository: repositoryId || null,
            scan: scan._id,
            provider: providerName,
            findingIdentityKey: f.findingIdentityKey,
            vulnerabilityId: f.vulnerabilityId,
            title: f.title || '',
            description: f.description || '',
            severity: f.severity,
            pkgName: f.pkgName,
            installedVersion: f.installedVersion || '',
            fixedVersion: f.fixedVersion || '',
            target: f.target || finalTarget,
            findingType: f.findingType,
            status: SECURITY_FINDING_STATUS.OPEN,
            primaryUrl: f.primaryUrl || '',
            references: f.references || [],
            firstDetectedAt: new Date(),
          }));

          await SecurityFinding.insertMany(findingDocs, { session });
        }

        // 5c. Finding lifecycle reconciliation
        const currentIdentityKeys = normalizedFindings.map((f) => f.findingIdentityKey);

        reconciliationStats = await SecurityReconciliationService.reconcileFindings({
          scanId: scan._id,
          projectId,
          repositoryId: repositoryId || null,
          target: finalTarget,
          provider: providerName,
          scanType: finalScanType,
          currentIdentityKeys,
          session,
        });

        // 5d. Complete the scan with summary and finding count
        await SecurityScan.updateOne(
          { _id: scan._id },
          {
            $set: {
              status: SECURITY_SCAN_STATUS.COMPLETED,
              summary,
              findingCount: normalizedFindings.length,
              completedAt: new Date(),
              duration: Math.round((Date.now() - scan.startedAt.getTime()) / 1000),
            },
          },
          { session }
        );
      });
    } catch (txError) {
      // If transaction fails due to MongoMemoryServer not supporting replicas,
      // fall back to non-transactional processing
      if (
        txError.message?.includes('Transaction') ||
        txError.message?.includes('replica set') ||
        txError.message?.includes('transaction') ||
        txError.codeName === 'IllegalOperation'
      ) {
        logger.warn(
          `${logPrefix} Transaction not supported (likely single-node). Falling back to non-transactional processing.`
        );

        // Non-transactional fallback
        scan = await SecurityScan.create({
          project: projectId,
          repository: repositoryId || null,
          pipelineRun: pipelineRunId || null,
          securityIntegration: securityIntegrationId,
          provider: providerName,
          scanType: finalScanType,
          target: finalTarget,
          commitSha: commitSha || '',
          branch: branch || '',
          status: SECURITY_SCAN_STATUS.PROCESSING,
          reportDigest,
          providerMetadata: providerMetadata || {},
          startedAt: new Date(),
        });

        if (normalizedFindings.length > 0) {
          const findingDocs = normalizedFindings.map((f) => ({
            project: projectId,
            repository: repositoryId || null,
            scan: scan._id,
            provider: providerName,
            findingIdentityKey: f.findingIdentityKey,
            vulnerabilityId: f.vulnerabilityId,
            title: f.title || '',
            description: f.description || '',
            severity: f.severity,
            pkgName: f.pkgName,
            installedVersion: f.installedVersion || '',
            fixedVersion: f.fixedVersion || '',
            target: f.target || finalTarget,
            findingType: f.findingType,
            status: SECURITY_FINDING_STATUS.OPEN,
            primaryUrl: f.primaryUrl || '',
            references: f.references || [],
            firstDetectedAt: new Date(),
          }));

          await SecurityFinding.insertMany(findingDocs);
        }

        const currentIdentityKeys = normalizedFindings.map((f) => f.findingIdentityKey);

        reconciliationStats = await SecurityReconciliationService.reconcileFindings({
          scanId: scan._id,
          projectId,
          repositoryId: repositoryId || null,
          target: finalTarget,
          provider: providerName,
          scanType: finalScanType,
          currentIdentityKeys,
        });

        await SecurityScan.updateOne(
          { _id: scan._id },
          {
            $set: {
              status: SECURITY_SCAN_STATUS.COMPLETED,
              summary,
              findingCount: normalizedFindings.length,
              completedAt: new Date(),
              duration: Math.round((Date.now() - scan.startedAt.getTime()) / 1000),
            },
          }
        );
      } else {
        // Genuine error: rethrow
        throw txError;
      }
    } finally {
      await session.endSession();
    }

    // 6. SecurityDelivery state: processing → processed
    await SecurityDelivery.findOneAndUpdate(
      { integration: securityIntegrationId, reportDigest },
      { $set: { status: 'processed' } }
    );

    // 7. Audit log for completed scan
    await AuditService.log({
      action: AUDIT_ACTIONS.SECURITY_SCAN_COMPLETED,
      entityType: ENTITY_TYPES.SECURITY_SCAN,
      entityId: scan._id,
      projectId,
      metadata: {
        provider: providerName,
        target: finalTarget,
        scanType: finalScanType,
        findingCount: normalizedFindings.length,
        summary,
        reconciliation: reconciliationStats,
      },
    });

    // 8. Trigger automatic policy evaluation (safe: after scan persistence commit)
    let gateStatus = null;
    try {
      const evalResult = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });
      gateStatus = evalResult.gateStatus;
    } catch (policyErr) {
      logger.error(`${logPrefix} Policy evaluation error: ${policyErr.message}`);
      // Do NOT fail the scan! DB scan persistence remains authoritative.
    }

    // 9. Publish security.scan.completed event via Redis Pub/Sub & Socket.io
    try {
      await publishSecurityEvent(SECURITY_EVENTS.SCAN_COMPLETED, {
        projectId: String(projectId),
        securityScanId: String(scan._id),
        pipelineRunId: pipelineRunId ? String(pipelineRunId) : null,
        repositoryId: repositoryId ? String(repositoryId) : null,
        provider: providerName,
        target: finalTarget,
        scanType: finalScanType,
        status: 'completed',
        summary,
        findingCount: normalizedFindings.length,
        gateStatus: gateStatus || scan.gateStatus || null,
      });
    } catch (eventErr) {
      logger.error(
        `${logPrefix} Failed to publish security.scan.completed event: ${eventErr.message}`
      );
      // Non-fatal: DB persistence remains authoritative
    }

    logger.info(
      `${logPrefix} Scan completed: scanId=${scan._id}, findings=${normalizedFindings.length}, ` +
        `resolved=${reconciliationStats.resolved}, reopened=${reconciliationStats.reopened}, ` +
        `preserved=${reconciliationStats.preserved}`
    );

    return {
      success: true,
      duplicate: false,
      scanId: scan._id,
      status: SECURITY_SCAN_STATUS.COMPLETED,
      findingCount: normalizedFindings.length,
      summary,
      gateStatus: gateStatus || scan.gateStatus || null,
      reconciliation: reconciliationStats,
    };
  } catch (err) {
    logger.error(`${logPrefix} Scan processing failed: ${err.message}`);

    // Mark delivery as failed with safe error message
    await SecurityDelivery.findOneAndUpdate(
      { integration: securityIntegrationId, reportDigest },
      {
        $set: {
          status: 'failed',
          errorMessage: err.message?.substring(0, 500) || 'Unknown processing error',
        },
      }
    ).catch((updateErr) => {
      logger.error(`${logPrefix} Failed to update delivery status: ${updateErr.message}`);
    });

    // Audit log for failed scan
    await AuditService.log({
      action: AUDIT_ACTIONS.SECURITY_SCAN_FAILED,
      entityType: ENTITY_TYPES.SECURITY_SCAN,
      projectId,
      metadata: {
        provider: providerName,
        reportDigest,
        error: err.message?.substring(0, 200),
      },
    });

    // Publish security.scan.failed event via Redis Pub/Sub & Socket.io
    try {
      await publishSecurityEvent(SECURITY_EVENTS.SCAN_FAILED, {
        projectId: String(projectId),
        securityScanId: scan?._id ? String(scan._id) : null,
        pipelineRunId: pipelineRunId ? String(pipelineRunId) : null,
        reportDigest,
        provider: providerName,
        status: 'failed',
        error: err.message?.substring(0, 200),
      });
    } catch (eventErr) {
      logger.error(
        `${logPrefix} Failed to publish security.scan.failed event: ${eventErr.message}`
      );
    }

    throw err;
  }
}

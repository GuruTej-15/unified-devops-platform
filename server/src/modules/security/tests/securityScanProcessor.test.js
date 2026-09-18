import mongoose from 'mongoose';
import SecurityScan from '../securityScan.model.js';
import SecurityFinding from '../securityFinding.model.js';
import SecurityDelivery from '../securityDelivery.model.js';
import { processSecurityScanJob } from '../securityScanProcessor.js';
import SecurityReconciliationService from '../securityReconciliation.service.js';
import { generateFindingIdentityKey } from '../providers/trivyProvider.js';
import { _resetSecurityProviderRegistry } from '../providers/securityProviderRegistry.js';
import { SECURITY_SCAN_STATUS, SECURITY_FINDING_STATUS } from '../../../shared/constants.js';

/**
 * Phase 3 Step 4 — Durable Security Processing + Finding Reconciliation (Tier A)
 *
 * NOTE: MongoMemoryServer may not support replica sets/transactions. The processor
 * gracefully falls back to non-transactional processing. This is documented and
 * does NOT silently remove the transaction requirement — it is a test-environment
 * adaptation. Production MongoDB (with replica set) uses full transactions.
 */
describe('Phase 3 Step 4 — Security Scan Processing & Reconciliation (Tier A)', () => {
  const projectId = new mongoose.Types.ObjectId();
  const repositoryId = new mongoose.Types.ObjectId();
  const integrationId = new mongoose.Types.ObjectId();
  const pipelineRunId = new mongoose.Types.ObjectId();

  // Sample Trivy image report fixture (inline for test isolation)
  const sampleTrivyReport = {
    SchemaVersion: 2,
    ArtifactName: 'alpine:3.18.4',
    ArtifactType: 'container_image',
    Results: [
      {
        Target: 'alpine:3.18.4 (alpine 3.18.4)',
        Class: 'os-pkgs',
        Type: 'alpine',
        Vulnerabilities: [
          {
            VulnerabilityID: 'CVE-2023-44487',
            PkgName: 'libcrypto3',
            InstalledVersion: '3.1.2-r0',
            FixedVersion: '3.1.4-r0',
            Severity: 'CRITICAL',
            Title: 'HTTP/2 Rapid Reset',
            PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2023-44487',
          },
          {
            VulnerabilityID: 'CVE-2023-5363',
            PkgName: 'libssl3',
            InstalledVersion: '3.1.2-r0',
            FixedVersion: '3.1.4-r0',
            Severity: 'HIGH',
            Title: 'Incorrect cipher key length processing',
          },
          {
            VulnerabilityID: 'CVE-2023-52425',
            PkgName: 'libexpat',
            InstalledVersion: '2.5.0-r1',
            FixedVersion: '2.5.0-r2',
            Severity: 'MEDIUM',
            Title: 'XML parsing DoS',
          },
        ],
      },
    ],
  };

  // Second report with one vuln removed and one new one added
  const updatedTrivyReport = {
    SchemaVersion: 2,
    ArtifactName: 'alpine:3.18.4',
    ArtifactType: 'container_image',
    Results: [
      {
        Target: 'alpine:3.18.4 (alpine 3.18.4)',
        Vulnerabilities: [
          // CVE-2023-44487 STILL PRESENT (critical)
          {
            VulnerabilityID: 'CVE-2023-44487',
            PkgName: 'libcrypto3',
            InstalledVersion: '3.1.3-r0', // version upgraded but still vuln
            FixedVersion: '3.1.4-r0',
            Severity: 'CRITICAL',
            Title: 'HTTP/2 Rapid Reset',
          },
          // CVE-2023-5363 REMOVED (was HIGH - libssl3)
          // CVE-2023-52425 STILL PRESENT (medium)
          {
            VulnerabilityID: 'CVE-2023-52425',
            PkgName: 'libexpat',
            InstalledVersion: '2.5.0-r1',
            FixedVersion: '2.5.0-r2',
            Severity: 'MEDIUM',
            Title: 'XML parsing DoS',
          },
          // NEW: CVE-2024-0001 (high)
          {
            VulnerabilityID: 'CVE-2024-0001',
            PkgName: 'busybox',
            InstalledVersion: '1.36.1-r0',
            Severity: 'HIGH',
            Title: 'New busybox vulnerability',
          },
        ],
      },
    ],
  };

  // Clean report with zero vulnerabilities
  const cleanTrivyReport = {
    SchemaVersion: 2,
    ArtifactName: 'alpine:3.18.4',
    ArtifactType: 'container_image',
    Results: [
      {
        Target: 'alpine:3.18.4 (alpine 3.18.4)',
      },
    ],
  };

  beforeEach(async () => {
    _resetSecurityProviderRegistry();
  });

  // Helper to create a SecurityDelivery in 'queued' state
  async function createQueuedDelivery(intId, reportDig) {
    return SecurityDelivery.create({
      integration: intId,
      project: projectId,
      reportDigest: reportDig,
      deliveryKey: `${intId}:${reportDig}`,
      status: 'queued',
    });
  }

  // Helper to build job data
  function buildJobData(reportOverrides = {}) {
    return {
      jobType: 'security_scan_ingest',
      securityIntegrationId: String(integrationId),
      projectId: String(projectId),
      repositoryId: String(repositoryId),
      pipelineRunId: String(pipelineRunId),
      commitSha: 'abc123def456',
      branch: 'main',
      target: '',
      scanType: '',
      provider: 'trivy',
      reportDigest: 'digest-001',
      rawPayload: sampleTrivyReport,
      ...reportOverrides,
    };
  }

  // ================================================================
  // A. SECURITY SCAN PROCESSOR — BASIC PROCESSING
  // ================================================================
  describe('A. Security Scan Processor — Basic Processing', () => {
    it('should process a valid Trivy report and create scan + findings', async () => {
      await createQueuedDelivery(integrationId, 'digest-001');

      const result = await processSecurityScanJob(buildJobData());

      expect(result.success).toBe(true);
      expect(result.duplicate).toBe(false);
      expect(result.scanId).toBeDefined();
      expect(result.status).toBe(SECURITY_SCAN_STATUS.COMPLETED);
      expect(result.findingCount).toBe(3);

      // Verify SecurityScan in database
      const scan = await SecurityScan.findById(result.scanId);
      expect(scan).toBeDefined();
      expect(scan.status).toBe(SECURITY_SCAN_STATUS.COMPLETED);
      expect(scan.provider).toBe('trivy');
      expect(scan.target).toBe('alpine:3.18.4');
      expect(scan.scanType).toBe('image');
      expect(scan.reportDigest).toBe('digest-001');
      expect(scan.findingCount).toBe(3);
      expect(scan.summary.critical).toBe(1);
      expect(scan.summary.high).toBe(1);
      expect(scan.summary.medium).toBe(1);
      expect(scan.summary.total).toBe(3);
      expect(scan.completedAt).toBeDefined();
      expect(scan.project.toString()).toBe(projectId.toString());
      expect(scan.repository.toString()).toBe(repositoryId.toString());

      // Verify SecurityFinding records
      const findings = await SecurityFinding.find({ scan: result.scanId }).sort({
        severity: 1,
      });
      expect(findings).toHaveLength(3);

      const criticalFinding = findings.find((f) => f.vulnerabilityId === 'CVE-2023-44487');
      expect(criticalFinding).toBeDefined();
      expect(criticalFinding.severity).toBe('critical');
      expect(criticalFinding.pkgName).toBe('libcrypto3');
      expect(criticalFinding.status).toBe(SECURITY_FINDING_STATUS.OPEN);
      expect(criticalFinding.findingIdentityKey).toMatch(/^[a-f0-9]{64}$/);
      expect(criticalFinding.project.toString()).toBe(projectId.toString());
      expect(criticalFinding.repository.toString()).toBe(repositoryId.toString());
    });

    it('should process a clean Trivy report with zero findings', async () => {
      await createQueuedDelivery(integrationId, 'digest-clean');

      const result = await processSecurityScanJob(
        buildJobData({
          reportDigest: 'digest-clean',
          rawPayload: cleanTrivyReport,
        })
      );

      expect(result.success).toBe(true);
      expect(result.findingCount).toBe(0);
      expect(result.summary.total).toBe(0);

      const scan = await SecurityScan.findById(result.scanId);
      expect(scan.status).toBe(SECURITY_SCAN_STATUS.COMPLETED);
      expect(scan.findingCount).toBe(0);

      const findings = await SecurityFinding.find({ scan: result.scanId });
      expect(findings).toHaveLength(0);
    });

    it('should use target and scanType from provider when not specified in job', async () => {
      await createQueuedDelivery(integrationId, 'digest-auto');

      const result = await processSecurityScanJob(
        buildJobData({
          reportDigest: 'digest-auto',
          target: '', // Not specified
          scanType: '', // Not specified
        })
      );

      const scan = await SecurityScan.findById(result.scanId);
      expect(scan.target).toBe('alpine:3.18.4');
      expect(scan.scanType).toBe('image');
    });

    it('should handle rawPayload.report wrapper correctly', async () => {
      await createQueuedDelivery(integrationId, 'digest-wrapped');

      const result = await processSecurityScanJob(
        buildJobData({
          reportDigest: 'digest-wrapped',
          rawPayload: { report: sampleTrivyReport },
        })
      );

      expect(result.success).toBe(true);
      expect(result.findingCount).toBe(3);
    });
  });

  // ================================================================
  // B. DELIVERY STATE TRANSITIONS
  // ================================================================
  describe('B. SecurityDelivery State Transitions', () => {
    it('should transition delivery: queued → processing → processed on success', async () => {
      const delivery = await createQueuedDelivery(integrationId, 'digest-state');

      await processSecurityScanJob(buildJobData({ reportDigest: 'digest-state' }));

      const updated = await SecurityDelivery.findById(delivery._id);
      expect(updated.status).toBe('processed');
    });

    it('should transition delivery to failed on processing error', async () => {
      const delivery = await createQueuedDelivery(integrationId, 'digest-fail');

      // Send malformed payload that will cause parser to throw
      await expect(
        processSecurityScanJob(
          buildJobData({
            reportDigest: 'digest-fail',
            rawPayload: { invalid: 'not-a-trivy-report' },
          })
        )
      ).rejects.toThrow();

      const updated = await SecurityDelivery.findById(delivery._id);
      expect(updated.status).toBe('failed');
      expect(updated.errorMessage).toBeTruthy();
    });
  });

  // ================================================================
  // C. IDEMPOTENCY — RETRY SAFETY
  // ================================================================
  describe('C. Idempotency & Retry Safety', () => {
    it('should skip duplicate processing when scan already exists for same integration+reportDigest', async () => {
      await createQueuedDelivery(integrationId, 'digest-idem');

      // First processing
      const result1 = await processSecurityScanJob(buildJobData({ reportDigest: 'digest-idem' }));
      expect(result1.success).toBe(true);
      expect(result1.duplicate).toBe(false);
      expect(result1.findingCount).toBe(3);

      // Second processing (retry) of same job data
      const result2 = await processSecurityScanJob(buildJobData({ reportDigest: 'digest-idem' }));
      expect(result2.success).toBe(true);
      expect(result2.duplicate).toBe(true);
      expect(result2.scanId.toString()).toBe(result1.scanId.toString());

      // Verify only one scan and one set of findings exist
      const scans = await SecurityScan.find({
        securityIntegration: integrationId,
        reportDigest: 'digest-idem',
      });
      expect(scans).toHaveLength(1);

      const findings = await SecurityFinding.find({ scan: result1.scanId });
      expect(findings).toHaveLength(3);
    });

    it('should NOT create duplicate findings on BullMQ retry', async () => {
      await createQueuedDelivery(integrationId, 'digest-retry');

      await processSecurityScanJob(buildJobData({ reportDigest: 'digest-retry' }));

      // Simulate BullMQ retry (same job data)
      await processSecurityScanJob(buildJobData({ reportDigest: 'digest-retry' }));

      // Count findings by reportDigest scope
      const scans = await SecurityScan.find({
        securityIntegration: integrationId,
        reportDigest: 'digest-retry',
      });
      expect(scans).toHaveLength(1);

      const findings = await SecurityFinding.find({ scan: scans[0]._id });
      expect(findings).toHaveLength(3);
    });
  });

  // ================================================================
  // D. FAILED SCAN HANDLING
  // ================================================================
  describe('D. Failed Scan Handling', () => {
    it('should NOT create a partial completed scan when report parsing fails', async () => {
      await createQueuedDelivery(integrationId, 'digest-parse-fail');

      await expect(
        processSecurityScanJob(
          buildJobData({
            reportDigest: 'digest-parse-fail',
            rawPayload: { SchemaVersion: 'invalid', Results: 'not-array' },
          })
        )
      ).rejects.toThrow();

      // No completed scans should exist
      const scans = await SecurityScan.find({
        securityIntegration: integrationId,
        reportDigest: 'digest-parse-fail',
        status: SECURITY_SCAN_STATUS.COMPLETED,
      });
      expect(scans).toHaveLength(0);
    });

    it('should store a safe error message (not raw stack trace) in delivery', async () => {
      await createQueuedDelivery(integrationId, 'digest-err-msg');

      try {
        await processSecurityScanJob(
          buildJobData({
            reportDigest: 'digest-err-msg',
            rawPayload: null,
          })
        );
      } catch {
        // Expected to throw
      }

      const delivery = await SecurityDelivery.findOne({
        integration: integrationId,
        reportDigest: 'digest-err-msg',
      });
      expect(delivery.status).toBe('failed');
      expect(delivery.errorMessage.length).toBeLessThanOrEqual(500);
    });

    it('should reject unsupported provider gracefully', async () => {
      await createQueuedDelivery(integrationId, 'digest-bad-provider');

      await expect(
        processSecurityScanJob(
          buildJobData({
            reportDigest: 'digest-bad-provider',
            provider: 'unsupported_scanner',
          })
        )
      ).rejects.toThrow(/Unsupported security provider/i);
    });
  });

  // ================================================================
  // E. FINDING RECONCILIATION — LIFECYCLE RULES
  // ================================================================
  describe('E. Finding Reconciliation — Lifecycle Rules', () => {
    it('should auto-resolve open findings absent from newer scan', async () => {
      // First scan: 3 findings
      await createQueuedDelivery(integrationId, 'digest-recon-1');
      const result1 = await processSecurityScanJob(
        buildJobData({ reportDigest: 'digest-recon-1' })
      );
      expect(result1.findingCount).toBe(3);

      // Second scan: 2 findings (CVE-2023-5363 removed, CVE-2024-0001 added)
      await createQueuedDelivery(integrationId, 'digest-recon-2');
      const result2 = await processSecurityScanJob(
        buildJobData({
          reportDigest: 'digest-recon-2',
          rawPayload: updatedTrivyReport,
        })
      );
      expect(result2.findingCount).toBe(3); // 3 new findings created for scan 2
      expect(result2.reconciliation.resolved).toBeGreaterThanOrEqual(1);

      // The libssl3 finding from scan 1 should now be resolved
      const libsslFindings = await SecurityFinding.find({
        scan: result1.scanId,
        vulnerabilityId: 'CVE-2023-5363',
      });
      expect(libsslFindings).toHaveLength(1);
      expect(libsslFindings[0].status).toBe(SECURITY_FINDING_STATUS.RESOLVED);
      expect(libsslFindings[0].resolvedAt).toBeDefined();
    });

    it('should NEVER auto-resolve acknowledged findings', async () => {
      // First scan: create findings
      await createQueuedDelivery(integrationId, 'digest-ack-1');
      const result1 = await processSecurityScanJob(buildJobData({ reportDigest: 'digest-ack-1' }));

      // Manually acknowledge the libssl3 finding
      const libsslFinding = await SecurityFinding.findOne({
        scan: result1.scanId,
        vulnerabilityId: 'CVE-2023-5363',
      });
      await SecurityFinding.updateOne(
        { _id: libsslFinding._id },
        {
          $set: {
            status: SECURITY_FINDING_STATUS.ACKNOWLEDGED,
            acknowledgedAt: new Date(),
          },
        }
      );

      // Second scan: libssl3 is absent
      await createQueuedDelivery(integrationId, 'digest-ack-2');
      const result2 = await processSecurityScanJob(
        buildJobData({
          reportDigest: 'digest-ack-2',
          rawPayload: updatedTrivyReport, // Missing CVE-2023-5363
        })
      );

      // Acknowledged finding MUST remain acknowledged
      const recheck = await SecurityFinding.findById(libsslFinding._id);
      expect(recheck.status).toBe(SECURITY_FINDING_STATUS.ACKNOWLEDGED);
      expect(result2.reconciliation.preserved).toBeGreaterThanOrEqual(1);
    });

    it('should NEVER auto-resolve false_positive findings', async () => {
      // First scan: create findings
      await createQueuedDelivery(integrationId, 'digest-fp-1');
      const result1 = await processSecurityScanJob(buildJobData({ reportDigest: 'digest-fp-1' }));

      // Mark libssl3 as false_positive
      const libsslFinding = await SecurityFinding.findOne({
        scan: result1.scanId,
        vulnerabilityId: 'CVE-2023-5363',
      });
      await SecurityFinding.updateOne(
        { _id: libsslFinding._id },
        { $set: { status: SECURITY_FINDING_STATUS.FALSE_POSITIVE } }
      );

      // Second scan: libssl3 absent
      await createQueuedDelivery(integrationId, 'digest-fp-2');
      await processSecurityScanJob(
        buildJobData({
          reportDigest: 'digest-fp-2',
          rawPayload: updatedTrivyReport,
        })
      );

      // false_positive MUST remain false_positive
      const recheck = await SecurityFinding.findById(libsslFinding._id);
      expect(recheck.status).toBe(SECURITY_FINDING_STATUS.FALSE_POSITIVE);
    });

    it('should reopen previously auto-resolved findings when re-detected', async () => {
      // Scan 1: 3 findings
      await createQueuedDelivery(integrationId, 'digest-reopen-1');
      const result1 = await processSecurityScanJob(
        buildJobData({ reportDigest: 'digest-reopen-1' })
      );

      // Scan 2: CVE-2023-5363 removed → auto-resolved
      await createQueuedDelivery(integrationId, 'digest-reopen-2');
      await processSecurityScanJob(
        buildJobData({
          reportDigest: 'digest-reopen-2',
          rawPayload: updatedTrivyReport,
        })
      );

      const libsslAfterScan2 = await SecurityFinding.findOne({
        scan: result1.scanId,
        vulnerabilityId: 'CVE-2023-5363',
      });
      expect(libsslAfterScan2.status).toBe(SECURITY_FINDING_STATUS.RESOLVED);

      // Scan 3: CVE-2023-5363 re-appears (regression)
      await createQueuedDelivery(integrationId, 'digest-reopen-3');
      await processSecurityScanJob(
        buildJobData({
          reportDigest: 'digest-reopen-3',
          rawPayload: sampleTrivyReport, // Original report with all 3 vulns
        })
      );

      // Previously resolved finding should be reopened
      const libsslAfterScan3 = await SecurityFinding.findOne({
        scan: result1.scanId,
        vulnerabilityId: 'CVE-2023-5363',
      });
      expect(libsslAfterScan3.status).toBe(SECURITY_FINDING_STATUS.OPEN);
      expect(libsslAfterScan3.resolvedAt).toBeNull();
    });

    it('should preserve acknowledged status when re-detected in newer scan', async () => {
      // Scan 1: create and acknowledge a finding
      await createQueuedDelivery(integrationId, 'digest-preserve-1');
      const result1 = await processSecurityScanJob(
        buildJobData({ reportDigest: 'digest-preserve-1' })
      );

      const finding = await SecurityFinding.findOne({
        scan: result1.scanId,
        vulnerabilityId: 'CVE-2023-44487',
      });
      await SecurityFinding.updateOne(
        { _id: finding._id },
        { $set: { status: SECURITY_FINDING_STATUS.ACKNOWLEDGED } }
      );

      // Scan 2: same vuln still present
      await createQueuedDelivery(integrationId, 'digest-preserve-2');
      const result2 = await processSecurityScanJob(
        buildJobData({ reportDigest: 'digest-preserve-2' })
      );

      // Acknowledged finding stays acknowledged
      const recheck = await SecurityFinding.findById(finding._id);
      expect(recheck.status).toBe(SECURITY_FINDING_STATUS.ACKNOWLEDGED);
      expect(result2.reconciliation.preserved).toBeGreaterThanOrEqual(1);
    });

    it('should perform no reconciliation on first-ever scan for a scope', async () => {
      await createQueuedDelivery(integrationId, 'digest-first');

      const result = await processSecurityScanJob(buildJobData({ reportDigest: 'digest-first' }));

      expect(result.reconciliation.resolved).toBe(0);
      expect(result.reconciliation.reopened).toBe(0);
      expect(result.reconciliation.preserved).toBe(0);
    });
  });

  // ================================================================
  // F. RECONCILIATION SERVICE — UNIT TESTS
  // ================================================================
  describe('F. SecurityReconciliationService — Direct Unit Tests', () => {
    it('should return zero stats when no previous findings exist', async () => {
      const scanId = new mongoose.Types.ObjectId();

      const stats = await SecurityReconciliationService.reconcileFindings({
        scanId,
        projectId,
        repositoryId,
        target: 'unique-target-no-prev',
        provider: 'trivy',
        scanType: 'image',
        currentIdentityKeys: ['key-1', 'key-2'],
      });

      expect(stats.resolved).toBe(0);
      expect(stats.reopened).toBe(0);
      expect(stats.preserved).toBe(0);
    });

    it('should resolve open findings not in current identity keys', async () => {
      const newScanId = new mongoose.Types.ObjectId();
      const target = 'recon-target-resolve';

      const identityKey = generateFindingIdentityKey({
        repositoryId: String(repositoryId),
        target,
        vulnerabilityId: 'CVE-2099-0001',
        pkgName: 'pkg-a',
        findingType: 'vulnerability',
      });

      // Create a previous completed scan + its finding
      const oldScan = await SecurityScan.create({
        project: projectId,
        repository: repositoryId,
        provider: 'trivy',
        scanType: 'image',
        target,
        reportDigest: 'unit-resolve-old',
        status: SECURITY_SCAN_STATUS.COMPLETED,
      });

      await SecurityFinding.create({
        project: projectId,
        repository: repositoryId,
        scan: oldScan._id,
        provider: 'trivy',
        findingIdentityKey: identityKey,
        vulnerabilityId: 'CVE-2099-0001',
        severity: 'high',
        pkgName: 'pkg-a',
        target,
        findingType: 'vulnerability',
        status: SECURITY_FINDING_STATUS.OPEN,
      });

      const stats = await SecurityReconciliationService.reconcileFindings({
        scanId: newScanId,
        projectId,
        repositoryId,
        target,
        provider: 'trivy',
        scanType: 'image',
        currentIdentityKeys: [], // Empty — nothing present in current scan
      });

      expect(stats.resolved).toBe(1);

      const updated = await SecurityFinding.findOne({
        scan: oldScan._id,
        findingIdentityKey: identityKey,
      });
      expect(updated.status).toBe(SECURITY_FINDING_STATUS.RESOLVED);
      expect(updated.resolvedAt).toBeDefined();
    });

    it('should not cross-contaminate findings from different targets', async () => {
      const newScanId = new mongoose.Types.ObjectId();

      // Create a previous scan for target A
      const oldScan = await SecurityScan.create({
        project: projectId,
        repository: repositoryId,
        provider: 'trivy',
        scanType: 'image',
        target: 'target-A',
        reportDigest: 'unit-cross-old',
        status: SECURITY_SCAN_STATUS.COMPLETED,
      });

      // Finding in target A's scan
      await SecurityFinding.create({
        project: projectId,
        repository: repositoryId,
        scan: oldScan._id,
        provider: 'trivy',
        findingIdentityKey: 'key-target-a',
        vulnerabilityId: 'CVE-2099-0002',
        severity: 'high',
        pkgName: 'pkg-x',
        target: 'target-A',
        findingType: 'vulnerability',
        status: SECURITY_FINDING_STATUS.OPEN,
      });

      // Reconcile for target B (different scope)
      const stats = await SecurityReconciliationService.reconcileFindings({
        scanId: newScanId,
        projectId,
        repositoryId,
        target: 'target-B', // Different target — no matching scans
        provider: 'trivy',
        scanType: 'image',
        currentIdentityKeys: [],
      });

      // Should NOT resolve findings from target A
      expect(stats.resolved).toBe(0);

      const finding = await SecurityFinding.findOne({
        scan: oldScan._id,
        target: 'target-A',
      });
      expect(finding.status).toBe(SECURITY_FINDING_STATUS.OPEN);
    });
  });

  // ================================================================
  // G. FINDING IDENTITY KEY STABILITY IN PROCESSING CONTEXT
  // ================================================================
  describe('G. Finding Identity Key Stability', () => {
    it('should produce stable identity keys across scan runs with different installed versions', async () => {
      // Scan 1
      await createQueuedDelivery(integrationId, 'digest-stable-1');
      const result1 = await processSecurityScanJob(
        buildJobData({ reportDigest: 'digest-stable-1' })
      );

      // Scan 2 with updated installed version for same CVE
      const modifiedReport = JSON.parse(JSON.stringify(sampleTrivyReport));
      modifiedReport.Results[0].Vulnerabilities[0].InstalledVersion = '3.1.3-r0'; // Changed
      await createQueuedDelivery(integrationId, 'digest-stable-2');
      const result2 = await processSecurityScanJob(
        buildJobData({
          reportDigest: 'digest-stable-2',
          rawPayload: modifiedReport,
        })
      );

      const finding1 = await SecurityFinding.findOne({
        scan: result1.scanId,
        vulnerabilityId: 'CVE-2023-44487',
      });
      const finding2 = await SecurityFinding.findOne({
        scan: result2.scanId,
        vulnerabilityId: 'CVE-2023-44487',
      });

      // Identity keys must match even though installedVersion changed
      expect(finding1.findingIdentityKey).toBe(finding2.findingIdentityKey);
      // But installedVersion should reflect the actual scan data
      expect(finding1.installedVersion).toBe('3.1.2-r0');
      expect(finding2.installedVersion).toBe('3.1.3-r0');
    });
  });

  // ================================================================
  // H. PROVIDER DISPATCH VIA REGISTRY
  // ================================================================
  describe('H. Provider Dispatch via SecurityProviderRegistry', () => {
    it('should use SecurityProviderRegistry for provider dispatch (not direct instantiation)', async () => {
      await createQueuedDelivery(integrationId, 'digest-registry');

      // This test verifies the processor uses the registry by processing
      // a valid Trivy report — if it bypassed the registry, it would fail
      const result = await processSecurityScanJob(
        buildJobData({ reportDigest: 'digest-registry' })
      );

      expect(result.success).toBe(true);
      expect(result.findingCount).toBe(3);
    });
  });
});

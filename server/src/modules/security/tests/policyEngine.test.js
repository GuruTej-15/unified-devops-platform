import mongoose from 'mongoose';
import SecurityScan from '../securityScan.model.js';
import SecurityFinding from '../securityFinding.model.js';
import GovernancePolicy from '../governancePolicy.model.js';
import PolicyGateResult from '../policyGateResult.model.js';
import AuditLog from '../../audit/audit.model.js';
import PolicyEngineService from '../policyEngine.service.js';
import {
  SECURITY_SCAN_STATUS,
  SECURITY_FINDING_STATUS,
  POLICY_RULE_TYPE,
  POLICY_ENFORCEMENT,
  POLICY_EVALUATION_STATE,
  AUDIT_ACTIONS,
} from '../../../shared/constants.js';

/**
 * Phase 3 Step 5 — Governance Policy Engine + Policy Gates (Tier A)
 *
 * Tests:
 * A. max_severity_count evaluation
 * B. required_scan evaluation
 * C. Aggregate gate status
 * D. Idempotency
 * E. Override
 * F. System errors
 */
describe('Phase 3 Step 5 — Policy Engine & Gates (Tier A)', () => {
  const projectId = new mongoose.Types.ObjectId();
  const repositoryId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const integrationId = new mongoose.Types.ObjectId();

  // ── Helpers ──────────────────────────────────────────────────────

  /** Create a completed SecurityScan. */
  async function createCompletedScan(overrides = {}) {
    return SecurityScan.create({
      project: projectId,
      repository: repositoryId,
      securityIntegration: integrationId,
      provider: 'trivy',
      scanType: 'image',
      target: 'alpine:3.18.4',
      reportDigest: `digest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: SECURITY_SCAN_STATUS.COMPLETED,
      summary: { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0, total: 0 },
      findingCount: 0,
      completedAt: new Date(),
      ...overrides,
    });
  }

  /** Create N open findings for a scan. */
  async function createFindings(scanId, count, severity = 'high') {
    const docs = [];
    for (let i = 0; i < count; i++) {
      docs.push({
        project: projectId,
        repository: repositoryId,
        scan: scanId,
        provider: 'trivy',
        findingIdentityKey: `key-${scanId}-${severity}-${i}`,
        vulnerabilityId: `CVE-2099-${String(i).padStart(4, '0')}`,
        severity,
        pkgName: `pkg-${i}`,
        target: 'alpine:3.18.4',
        findingType: 'vulnerability',
        status: SECURITY_FINDING_STATUS.OPEN,
      });
    }
    return SecurityFinding.insertMany(docs);
  }

  /** Create a governance policy. */
  async function createPolicy(overrides = {}) {
    return GovernancePolicy.create({
      project: projectId,
      name: `test-policy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
      ruleConfig: { severity: 'high', maxCount: 0 },
      enforcement: POLICY_ENFORCEMENT.BLOCKING,
      createdBy: userId,
      isActive: true,
      ...overrides,
    });
  }

  // ================================================================
  // A. MAX_SEVERITY_COUNT EVALUATION
  // ================================================================
  describe('A. max_severity_count Evaluation', () => {
    it('should PASS when zero findings exist', async () => {
      const scan = await createCompletedScan();
      await createPolicy({ name: 'no-high', ruleConfig: { severity: 'high', maxCount: 0 } });

      const { gateStatus, results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.PASS);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].evaluationStatus).toBe(POLICY_EVALUATION_STATE.PASS);
      expect(results[0].evaluatedData.actualCount).toBe(0);
    });

    it('should PASS when count is exactly at maxCount', async () => {
      const scan = await createCompletedScan();
      await createFindings(scan._id, 3, 'high');
      await createPolicy({
        name: 'max-three-high',
        ruleConfig: { severity: 'high', maxCount: 3 },
      });

      const { gateStatus, results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.PASS);
      expect(results[0].passed).toBe(true);
      expect(results[0].evaluatedData.actualCount).toBe(3);
      expect(results[0].evaluatedData.maxCount).toBe(3);
    });

    it('should FAIL when count exceeds maxCount', async () => {
      const scan = await createCompletedScan();
      await createFindings(scan._id, 3, 'high');
      await createPolicy({
        name: 'zero-high',
        ruleConfig: { severity: 'high', maxCount: 0 },
      });

      const { gateStatus, results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
      expect(results[0].passed).toBe(false);
      expect(results[0].evaluationStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
      expect(results[0].evaluatedData.actualCount).toBe(3);
    });

    it('should filter by correct severity only', async () => {
      const scan = await createCompletedScan();
      await createFindings(scan._id, 5, 'medium');
      await createFindings(scan._id, 0, 'critical');
      await createPolicy({
        name: 'zero-critical',
        ruleConfig: { severity: 'critical', maxCount: 0 },
      });

      const { gateStatus, results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      // Zero critical findings despite 5 medium ones
      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.PASS);
      expect(results[0].passed).toBe(true);
      expect(results[0].evaluatedData.actualCount).toBe(0);
      expect(results[0].evaluatedData.severity).toBe('critical');
    });

    it('should evaluate multiple severity policies independently', async () => {
      const scan = await createCompletedScan();
      await createFindings(scan._id, 2, 'high');
      await createFindings(scan._id, 1, 'critical');

      await createPolicy({
        name: 'max-high-5',
        ruleConfig: { severity: 'high', maxCount: 5 },
      });
      await createPolicy({
        name: 'zero-critical-strict',
        ruleConfig: { severity: 'critical', maxCount: 0 },
      });

      const { gateStatus, results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
      expect(results).toHaveLength(2);

      const highResult = results.find((r) => r.evaluatedData.severity === 'high');
      const criticalResult = results.find((r) => r.evaluatedData.severity === 'critical');
      expect(highResult.passed).toBe(true);
      expect(criticalResult.passed).toBe(false);
    });

    it('should exclude resolved findings from count', async () => {
      const scan = await createCompletedScan();
      const findings = await createFindings(scan._id, 3, 'high');
      // Resolve two of the three
      await SecurityFinding.updateOne(
        { _id: findings[0]._id },
        { $set: { status: SECURITY_FINDING_STATUS.RESOLVED } }
      );
      await SecurityFinding.updateOne(
        { _id: findings[1]._id },
        { $set: { status: SECURITY_FINDING_STATUS.RESOLVED } }
      );

      await createPolicy({
        name: 'max-zero-high-resolved',
        ruleConfig: { severity: 'high', maxCount: 0 },
      });

      const { gateStatus, results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      // Only 1 open high finding remains
      expect(results[0].evaluatedData.actualCount).toBe(1);
      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
    });

    it('should exclude false_positive findings from count', async () => {
      const scan = await createCompletedScan();
      const findings = await createFindings(scan._id, 2, 'high');
      await SecurityFinding.updateMany(
        { _id: { $in: findings.map((f) => f._id) } },
        { $set: { status: SECURITY_FINDING_STATUS.FALSE_POSITIVE } }
      );

      await createPolicy({
        name: 'max-zero-high-fp',
        ruleConfig: { severity: 'high', maxCount: 0 },
      });

      const { results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(results[0].evaluatedData.actualCount).toBe(0);
      expect(results[0].passed).toBe(true);
    });

    it('should exclude acknowledged findings from count', async () => {
      const scan = await createCompletedScan();
      const findings = await createFindings(scan._id, 2, 'high');
      await SecurityFinding.updateMany(
        { _id: { $in: findings.map((f) => f._id) } },
        { $set: { status: SECURITY_FINDING_STATUS.ACKNOWLEDGED } }
      );

      await createPolicy({
        name: 'max-zero-high-ack',
        ruleConfig: { severity: 'high', maxCount: 0 },
      });

      const { results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(results[0].evaluatedData.actualCount).toBe(0);
      expect(results[0].passed).toBe(true);
    });

    it('should reject malformed ruleConfig with NOT_EVALUATED', async () => {
      const scan = await createCompletedScan();
      // Bypass Mongoose model validation to inject malformed ruleConfig
      const policyDoc = await mongoose.connection.db.collection('governancepolicies').insertOne({
        project: projectId,
        name: `malformed-config-${Date.now()}`,
        ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
        ruleConfig: { severity: 'high', maxCount: -5 },
        enforcement: POLICY_ENFORCEMENT.BLOCKING,
        createdBy: userId,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const { results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      const result = results.find((r) => r.policy.toString() === policyDoc.insertedId.toString());
      expect(result.evaluationStatus).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
      expect(result.passed).toBe(false);
    });
  });

  // ================================================================
  // B. REQUIRED_SCAN EVALUATION
  // ================================================================
  describe('B. required_scan Evaluation', () => {
    it('should PASS when a recent qualifying scan exists', async () => {
      // Create a recent completed scan that qualifies
      const scan = await createCompletedScan({
        completedAt: new Date(),
        scanType: 'image',
        provider: 'trivy',
      });

      await createPolicy({
        name: 'require-image-scan',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { provider: 'trivy', scanType: 'image', maxAgeSeconds: 86400 },
      });

      const { gateStatus, results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.PASS);
      expect(results[0].passed).toBe(true);
      expect(results[0].evaluatedData.qualifyingScanFound).toBe(true);
      expect(results[0].evaluatedData.scanAgeHours).toBeDefined();
    });

    it('should return NOT_EVALUATED when no qualifying scan exists', async () => {
      // Create a scan but with a different scanType
      const scan = await createCompletedScan({ scanType: 'filesystem' });

      await createPolicy({
        name: 'require-image-none',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { provider: 'trivy', scanType: 'image', maxAgeSeconds: 86400 },
      });

      const { gateStatus, results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
      expect(results[0].evaluationStatus).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
      expect(results[0].evaluatedData.qualifyingScanFound).toBe(false);
    });

    it('should return NOT_EVALUATED when only processing scans exist', async () => {
      // The evaluated scan itself is completed, but require a different scan type
      const scan = await createCompletedScan({ scanType: 'filesystem' });

      // Create a processing scan for the required type
      await SecurityScan.create({
        project: projectId,
        repository: repositoryId,
        provider: 'trivy',
        scanType: 'image',
        target: 'alpine:3.18.4',
        reportDigest: `digest-processing-${Date.now()}`,
        status: SECURITY_SCAN_STATUS.PROCESSING,
      });

      await createPolicy({
        name: 'require-image-processing',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { provider: 'trivy', scanType: 'image', maxAgeSeconds: 86400 },
      });

      const { results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(results[0].evaluationStatus).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
    });

    it('should return NOT_EVALUATED when only failed scans exist', async () => {
      const scan = await createCompletedScan({ scanType: 'filesystem' });

      await SecurityScan.create({
        project: projectId,
        repository: repositoryId,
        provider: 'trivy',
        scanType: 'image',
        target: 'alpine:3.18.4',
        reportDigest: `digest-failed-${Date.now()}`,
        status: SECURITY_SCAN_STATUS.FAILED,
        completedAt: new Date(),
      });

      await createPolicy({
        name: 'require-image-failed',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { provider: 'trivy', scanType: 'image', maxAgeSeconds: 86400 },
      });

      const { results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(results[0].evaluationStatus).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
    });

    it('should FAIL when scan exists but is older than maxAge', async () => {
      // Create an old scan (25 hours ago)
      const oldDate = new Date(Date.now() - 25 * 3600 * 1000);
      await createCompletedScan({
        scanType: 'image',
        provider: 'trivy',
        completedAt: oldDate,
        reportDigest: `digest-old-${Date.now()}`,
      });

      // Create the scan being evaluated (filesystem type, so it doesn't qualify itself)
      const scan = await createCompletedScan({ scanType: 'filesystem' });

      await createPolicy({
        name: 'require-image-stale',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { provider: 'trivy', scanType: 'image', maxAgeSeconds: 86400 }, // 24h
      });

      const { gateStatus, results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
      expect(results[0].passed).toBe(false);
      expect(results[0].evaluatedData.qualifyingScanFound).toBe(true);
      expect(results[0].evaluatedData.scanAgeHours).toBeGreaterThan(24);
    });

    it('should not match scan from wrong repository', async () => {
      const otherRepoId = new mongoose.Types.ObjectId();
      // Create scan in a different repository
      await createCompletedScan({
        repository: otherRepoId,
        scanType: 'image',
        reportDigest: `digest-other-repo-${Date.now()}`,
      });

      // Evaluated scan is in our repositoryId
      const scan = await createCompletedScan({ scanType: 'filesystem' });

      await createPolicy({
        name: 'require-image-wrong-repo',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { provider: 'trivy', scanType: 'image', maxAgeSeconds: 86400 },
      });

      const { results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      // Should NOT find the scan from the other repo
      expect(results[0].evaluatedData.qualifyingScanFound).toBe(false);
    });

    it('should not match scan from wrong provider', async () => {
      const scan = await createCompletedScan({ scanType: 'filesystem' });

      // Image scan with trivy exists
      await createCompletedScan({
        scanType: 'image',
        provider: 'trivy',
        reportDigest: `digest-trivy-${Date.now()}`,
      });

      // But policy requires generic provider
      await createPolicy({
        name: 'require-generic',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { provider: 'generic', scanType: 'image', maxAgeSeconds: 86400 },
      });

      const { results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(results[0].evaluatedData.qualifyingScanFound).toBe(false);
    });

    it('should not match scan from wrong scan type', async () => {
      const scan = await createCompletedScan({ scanType: 'filesystem' });

      // Only filesystem scans exist, policy requires config
      await createPolicy({
        name: 'require-config',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { scanType: 'config', maxAgeSeconds: 86400 },
      });

      const { results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(results[0].evaluatedData.qualifyingScanFound).toBe(false);
    });

    it('should handle maxAge boundary deterministically', async () => {
      // Create a scan at exactly the age boundary (23.9h ago, max 24h)
      const justUnder = new Date(Date.now() - 23.9 * 3600 * 1000);
      await createCompletedScan({
        scanType: 'image',
        completedAt: justUnder,
        reportDigest: `digest-boundary-${Date.now()}`,
      });

      const scan = await createCompletedScan({ scanType: 'filesystem' });

      await createPolicy({
        name: 'require-image-boundary',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { provider: 'trivy', scanType: 'image', maxAgeSeconds: 86400 },
      });

      const { results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(results[0].passed).toBe(true);
      expect(results[0].evaluatedData.qualifyingScanFound).toBe(true);
    });
  });

  // ================================================================
  // C. AGGREGATE GATE STATUS
  // ================================================================
  describe('C. Aggregate Gate Status', () => {
    it('should return PASS when all policies pass', async () => {
      const scan = await createCompletedScan();
      await createPolicy({
        name: 'all-pass-1',
        ruleConfig: { severity: 'critical', maxCount: 100 },
      });
      await createPolicy({
        name: 'all-pass-2',
        ruleConfig: { severity: 'high', maxCount: 100 },
      });

      const { gateStatus } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.PASS);
    });

    it('should return FAIL when a blocking policy fails', async () => {
      const scan = await createCompletedScan();
      await createFindings(scan._id, 5, 'high');
      await createPolicy({
        name: 'blocking-fail',
        ruleConfig: { severity: 'high', maxCount: 0 },
        enforcement: POLICY_ENFORCEMENT.BLOCKING,
      });

      const { gateStatus } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
    });

    it('should return WARNING when only warning policies fail', async () => {
      const scan = await createCompletedScan();
      await createFindings(scan._id, 3, 'medium');
      await createPolicy({
        name: 'warn-medium',
        ruleConfig: { severity: 'medium', maxCount: 0 },
        enforcement: POLICY_ENFORCEMENT.WARNING,
      });

      const { gateStatus, results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.WARNING);
      expect(results[0].evaluationStatus).toBe(POLICY_EVALUATION_STATE.WARNING);
    });

    it('should return NOT_EVALUATED when only NOT_EVALUATED exists', async () => {
      const scan = await createCompletedScan({ scanType: 'filesystem' });
      await createPolicy({
        name: 'only-not-eval',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { scanType: 'image', maxAgeSeconds: 86400 },
      });

      const { gateStatus } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
    });

    it('should return FAIL when FAIL + WARNING exist', async () => {
      const scan = await createCompletedScan();
      await createFindings(scan._id, 2, 'high');
      await createFindings(scan._id, 3, 'medium');

      await createPolicy({
        name: 'fail-high-mixed',
        ruleConfig: { severity: 'high', maxCount: 0 },
        enforcement: POLICY_ENFORCEMENT.BLOCKING,
      });
      await createPolicy({
        name: 'warn-medium-mixed',
        ruleConfig: { severity: 'medium', maxCount: 0 },
        enforcement: POLICY_ENFORCEMENT.WARNING,
      });

      const { gateStatus } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
    });

    it('should return FAIL when FAIL + NOT_EVALUATED exist', async () => {
      const scan = await createCompletedScan({ scanType: 'filesystem' });
      await createFindings(scan._id, 2, 'high');

      await createPolicy({
        name: 'fail-high-ne',
        ruleConfig: { severity: 'high', maxCount: 0 },
        enforcement: POLICY_ENFORCEMENT.BLOCKING,
      });
      await createPolicy({
        name: 'require-missing-ne',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { scanType: 'image', maxAgeSeconds: 86400 },
      });

      const { gateStatus } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
    });

    it('should return WARNING when WARNING + NOT_EVALUATED exist', async () => {
      const scan = await createCompletedScan({ scanType: 'filesystem' });
      await createFindings(scan._id, 2, 'medium');

      await createPolicy({
        name: 'warn-medium-ne',
        ruleConfig: { severity: 'medium', maxCount: 0 },
        enforcement: POLICY_ENFORCEMENT.WARNING,
      });
      await createPolicy({
        name: 'require-missing-warn',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { scanType: 'image', maxAgeSeconds: 86400 },
      });

      const { gateStatus } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.WARNING);
    });

    it('should return NOT_EVALUATED when PASS + NOT_EVALUATED exist', async () => {
      const scan = await createCompletedScan({ scanType: 'filesystem' });

      await createPolicy({
        name: 'pass-no-findings-ne',
        ruleConfig: { severity: 'high', maxCount: 100 },
        enforcement: POLICY_ENFORCEMENT.BLOCKING,
      });
      await createPolicy({
        name: 'require-image-ne-pass',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: { scanType: 'image', maxAgeSeconds: 86400 },
      });

      const { gateStatus } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
    });

    it('should return PASS when no active policies exist', async () => {
      const scan = await createCompletedScan();
      // No policies created

      const { gateStatus, results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(gateStatus).toBe(POLICY_EVALUATION_STATE.PASS);
      expect(results).toHaveLength(0);
    });
  });

  // ================================================================
  // D. IDEMPOTENCY
  // ================================================================
  describe('D. Idempotency', () => {
    it('should not create duplicate gate results on re-evaluation', async () => {
      const scan = await createCompletedScan();
      await createFindings(scan._id, 2, 'high');
      const policy = await createPolicy({
        name: 'idem-policy',
        ruleConfig: { severity: 'high', maxCount: 0 },
      });

      // Evaluate twice
      await PolicyEngineService.evaluatePolicies({ projectId, securityScanId: scan._id });
      await PolicyEngineService.evaluatePolicies({ projectId, securityScanId: scan._id });

      const gateResults = await PolicyGateResult.find({
        scan: scan._id,
        policy: policy._id,
      });

      expect(gateResults).toHaveLength(1);
    });

    it('should produce deterministic results on re-evaluation', async () => {
      const scan = await createCompletedScan();
      await createFindings(scan._id, 3, 'critical');
      await createPolicy({
        name: 'idem-determ',
        ruleConfig: { severity: 'critical', maxCount: 1 },
      });

      const result1 = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });
      const result2 = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(result1.gateStatus).toBe(result2.gateStatus);
      expect(result1.results[0].passed).toBe(result2.results[0].passed);
      expect(result1.results[0].evaluatedData.actualCount).toBe(
        result2.results[0].evaluatedData.actualCount
      );
    });
  });

  // ================================================================
  // E. MANUAL OVERRIDE
  // ================================================================
  describe('E. Manual Override', () => {
    let scan;
    let _policy;
    let gateResult;

    beforeEach(async () => {
      scan = await createCompletedScan();
      await createFindings(scan._id, 5, 'high');
      _policy = await createPolicy({
        name: `override-policy-${Date.now()}`,
        ruleConfig: { severity: 'high', maxCount: 0 },
      });

      const evalResult = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });
      gateResult = evalResult.results[0];
    });

    it('should succeed for authorized actor with valid justification', async () => {
      const overridden = await PolicyEngineService.overridePolicyGate({
        gateResultId: gateResult._id,
        actorId: userId,
        projectId,
        justification: 'Emergency release approved by security team for hotfix deployment',
      });

      expect(overridden.isOverridden).toBe(true);
      expect(overridden.overrideStatus).toBe('approved');
      expect(overridden.overriddenBy.toString()).toBe(userId.toString());
      expect(overridden.overriddenAt).toBeDefined();
      expect(overridden.overrideJustification).toContain('Emergency release');
    });

    it('should preserve original passed=false after override', async () => {
      const overridden = await PolicyEngineService.overridePolicyGate({
        gateResultId: gateResult._id,
        actorId: userId,
        projectId,
        justification: 'Override approved by CISO for critical incident response',
      });

      // Original evaluation MUST be preserved
      expect(overridden.passed).toBe(false);
    });

    it('should preserve original FAIL evaluationStatus after override', async () => {
      const overridden = await PolicyEngineService.overridePolicyGate({
        gateResultId: gateResult._id,
        actorId: userId,
        projectId,
        justification: 'Override approved by security lead for production hotfix',
      });

      expect(overridden.evaluationStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
    });

    it('should record override metadata correctly', async () => {
      const justification = 'Override approved after manual security review by team lead';
      const overridden = await PolicyEngineService.overridePolicyGate({
        gateResultId: gateResult._id,
        actorId: userId,
        projectId,
        justification,
      });

      expect(overridden.overrideJustification).toBe(justification);
      expect(overridden.overriddenBy.toString()).toBe(userId.toString());
      expect(overridden.overriddenAt).toBeInstanceOf(Date);
    });

    it('should reject missing justification', async () => {
      await expect(
        PolicyEngineService.overridePolicyGate({
          gateResultId: gateResult._id,
          actorId: userId,
          projectId,
          justification: '',
        })
      ).rejects.toThrow(/justification/i);
    });

    it('should reject too-short justification', async () => {
      await expect(
        PolicyEngineService.overridePolicyGate({
          gateResultId: gateResult._id,
          actorId: userId,
          projectId,
          justification: 'short',
        })
      ).rejects.toThrow(/justification/i);
    });

    it('should reject override of non-existent gate result', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(
        PolicyEngineService.overridePolicyGate({
          gateResultId: fakeId,
          actorId: userId,
          projectId,
          justification: 'This should fail because the gate result does not exist',
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should reject double override', async () => {
      await PolicyEngineService.overridePolicyGate({
        gateResultId: gateResult._id,
        actorId: userId,
        projectId,
        justification: 'First override for critical production incident response',
      });

      await expect(
        PolicyEngineService.overridePolicyGate({
          gateResultId: gateResult._id,
          actorId: userId,
          projectId,
          justification: 'Second override attempt should fail cleanly',
        })
      ).rejects.toThrow(/already been overridden/i);
    });

    it('should create an audit event for override', async () => {
      await PolicyEngineService.overridePolicyGate({
        gateResultId: gateResult._id,
        actorId: userId,
        projectId,
        justification: 'Override for audit verification test case validation',
      });

      const auditLogs = await AuditLog.find({
        action: AUDIT_ACTIONS.POLICY_GATE_OVERRIDDEN,
        entityId: gateResult._id,
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].actor.toString()).toBe(userId.toString());
      expect(auditLogs[0].metadata.originalPassed).toBe(false);
      expect(auditLogs[0].metadata.originalEvaluationStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
      expect(auditLogs[0].metadata.overrideJustification).toContain('audit verification');
    });

    it('should NOT allow override to erase original result', async () => {
      const overridden = await PolicyEngineService.overridePolicyGate({
        gateResultId: gateResult._id,
        actorId: userId,
        projectId,
        justification: 'Override must not erase original security assessment result',
      });

      // Verify original gate state is preserved
      expect(overridden.originalGateState).toBeDefined();
      expect(overridden.originalGateState.passed).toBe(false);
      expect(overridden.originalGateState.evaluationStatus).toBe(POLICY_EVALUATION_STATE.FAIL);

      // passed and evaluationStatus must NOT be changed
      expect(overridden.passed).toBe(false);
      expect(overridden.evaluationStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
    });

    it('should reject override for gate result in different project', async () => {
      const otherProjectId = new mongoose.Types.ObjectId();
      await expect(
        PolicyEngineService.overridePolicyGate({
          gateResultId: gateResult._id,
          actorId: userId,
          projectId: otherProjectId,
          justification: 'Cross-project override must be rejected for security isolation',
        })
      ).rejects.toThrow(/not found/i);
    });
  });

  // ================================================================
  // F. SYSTEM ERRORS
  // ================================================================
  describe('F. System Error Handling', () => {
    it('should return NOT_EVALUATED for unsupported rule types (not FAIL)', async () => {
      const scan = await createCompletedScan();

      // Manually insert a policy with an unsupported ruleType
      // (bypass Mongoose enum validation)
      const policyDoc = await mongoose.connection.db.collection('governancepolicies').insertOne({
        project: projectId,
        name: `unsupported-rule-${Date.now()}`,
        ruleType: 'license_block',
        ruleConfig: { blocked: ['GPL-3.0'] },
        enforcement: 'blocking',
        createdBy: userId,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const { results } = await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      const unsupportedResult = results.find(
        (r) => r.policy.toString() === policyDoc.insertedId.toString()
      );
      expect(unsupportedResult).toBeDefined();
      expect(unsupportedResult.evaluationStatus).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
      // NOT a false FAIL — this is a system/evaluation limitation
      expect(unsupportedResult.evaluationStatus).not.toBe(POLICY_EVALUATION_STATE.FAIL);
    });

    it('should throw when scan does not exist', async () => {
      const fakeScanId = new mongoose.Types.ObjectId();
      await expect(
        PolicyEngineService.evaluatePolicies({
          projectId,
          securityScanId: fakeScanId,
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should throw when scan is not completed', async () => {
      const scan = await SecurityScan.create({
        project: projectId,
        repository: repositoryId,
        provider: 'trivy',
        scanType: 'image',
        target: 'alpine:3.18.4',
        reportDigest: `digest-processing-${Date.now()}`,
        status: SECURITY_SCAN_STATUS.PROCESSING,
      });

      await expect(
        PolicyEngineService.evaluatePolicies({
          projectId,
          securityScanId: scan._id,
        })
      ).rejects.toThrow(/not completed/i);
    });

    it('should verify scan belongs to the specified project', async () => {
      const otherProjectId = new mongoose.Types.ObjectId();
      const scan = await createCompletedScan();

      await expect(
        PolicyEngineService.evaluatePolicies({
          projectId: otherProjectId,
          securityScanId: scan._id,
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should update gateStatus on SecurityScan after evaluation', async () => {
      const scan = await createCompletedScan();
      await createFindings(scan._id, 3, 'high');
      await createPolicy({
        name: 'gate-update-check',
        ruleConfig: { severity: 'high', maxCount: 0 },
      });

      await PolicyEngineService.evaluatePolicies({ projectId, securityScanId: scan._id });

      const updatedScan = await SecurityScan.findById(scan._id);
      expect(updatedScan.gateStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
    });

    it('should create an audit event for policy evaluation', async () => {
      const scan = await createCompletedScan();
      await createPolicy({
        name: 'audit-eval-check',
        ruleConfig: { severity: 'critical', maxCount: 100 },
      });

      await PolicyEngineService.evaluatePolicies({ projectId, securityScanId: scan._id });

      const auditLogs = await AuditLog.find({
        action: AUDIT_ACTIONS.POLICY_GATE_EVALUATED,
        entityId: scan._id,
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      expect(auditLogs[0].metadata.gateStatus).toBe(POLICY_EVALUATION_STATE.PASS);
      expect(auditLogs[0].metadata.policiesEvaluated).toBe(1);
    });
  });
});

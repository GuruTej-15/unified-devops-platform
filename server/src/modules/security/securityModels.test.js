import mongoose from 'mongoose';
import SecurityIntegration from './securityIntegration.model.js';
import SecurityScan from './securityScan.model.js';
import SecurityFinding from './securityFinding.model.js';
import GovernancePolicy from './governancePolicy.model.js';
import PolicyGateResult from './policyGateResult.model.js';
import {
  SECURITY_PROVIDER,
  SECURITY_SCAN_STATUS,
  SECURITY_SCAN_TYPE,
  SECURITY_SEVERITY,
  SECURITY_FINDING_TYPE,
  SECURITY_FINDING_STATUS,
  POLICY_RULE_TYPE,
  POLICY_ENFORCEMENT,
  POLICY_EVALUATION_STATE,
} from '../../shared/constants.js';

describe('Phase 3 Security & Governance Models (Tier A)', () => {
  const projectId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const repositoryId = new mongoose.Types.ObjectId();
  const pipelineRunId = new mongoose.Types.ObjectId();

  describe('SecurityIntegration Model', () => {
    const validIntegrationData = {
      project: projectId,
      name: 'CI Trivy Scanner',
      provider: SECURITY_PROVIDER.TRIVY,
      encryptedIngestionSecret: 'abcdef1234567890',
      ingestionSecretIv: '1234567890abcdef',
      ingestionSecretAuthTag: 'fedcba0987654321',
      ingestionSecretHint: '••••••••4321',
      createdBy: userId,
    };

    it('should successfully create a SecurityIntegration with valid fields', async () => {
      const integration = await SecurityIntegration.create(validIntegrationData);
      expect(integration._id).toBeDefined();
      expect(integration.name).toBe('CI Trivy Scanner');
      expect(integration.provider).toBe(SECURITY_PROVIDER.TRIVY);
      expect(integration.isActive).toBe(true);
      expect(integration.repository).toBeNull();
      expect(integration.lastUsedAt).toBeNull();
    });

    it('should support optional repository scoping', async () => {
      const integration = await SecurityIntegration.create({
        ...validIntegrationData,
        name: 'Repo Scoped Scanner',
        repository: repositoryId,
      });
      expect(integration.repository.toString()).toBe(repositoryId.toString());
    });

    it('should fail validation when required fields are missing', async () => {
      const invalid = new SecurityIntegration({});
      let err;
      try {
        await invalid.validate();
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.errors.project).toBeDefined();
      expect(err.errors.name).toBeDefined();
      expect(err.errors.encryptedIngestionSecret).toBeDefined();
      expect(err.errors.ingestionSecretIv).toBeDefined();
      expect(err.errors.ingestionSecretAuthTag).toBeDefined();
      expect(err.errors.createdBy).toBeDefined();
    });

    it('should reject invalid provider enum values', async () => {
      const invalid = new SecurityIntegration({
        ...validIntegrationData,
        provider: 'unsupported_scanner',
      });
      await expect(invalid.validate()).rejects.toThrow();
    });

    it('should hide encrypted credential fields by default (select: false)', async () => {
      const integration = await SecurityIntegration.create({
        ...validIntegrationData,
        name: 'Secret Selection Test',
      });
      const fetched = await SecurityIntegration.findById(integration._id);
      expect(fetched.encryptedIngestionSecret).toBeUndefined();
      expect(fetched.ingestionSecretIv).toBeUndefined();
      expect(fetched.ingestionSecretAuthTag).toBeUndefined();
      expect(fetched.ingestionSecretHint).toBe('••••••••4321');
    });

    it('should strip encrypted credential fields from JSON and Object serialization', async () => {
      const integration = await SecurityIntegration.create({
        ...validIntegrationData,
        name: 'Serialization Test',
      });
      const withSecrets = await SecurityIntegration.findById(integration._id).select(
        '+encryptedIngestionSecret +ingestionSecretIv +ingestionSecretAuthTag'
      );
      expect(withSecrets.encryptedIngestionSecret).toBeDefined();

      const json = withSecrets.toJSON();
      expect(json.encryptedIngestionSecret).toBeUndefined();
      expect(json.ingestionSecretIv).toBeUndefined();
      expect(json.ingestionSecretAuthTag).toBeUndefined();

      const obj = withSecrets.toObject();
      expect(obj.encryptedIngestionSecret).toBeUndefined();
      expect(obj.ingestionSecretIv).toBeUndefined();
      expect(obj.ingestionSecretAuthTag).toBeUndefined();
    });

    it('should enforce unique compound index on { project, name }', async () => {
      await SecurityIntegration.create({
        ...validIntegrationData,
        name: 'Duplicate Name Test',
      });
      await expect(
        SecurityIntegration.create({
          ...validIntegrationData,
          name: 'Duplicate Name Test',
        })
      ).rejects.toThrow(/duplicate key/i);
    });

    it('should allow same integration name in different projects', async () => {
      const otherProjectId = new mongoose.Types.ObjectId();
      await SecurityIntegration.create({
        ...validIntegrationData,
        name: 'Cross Project Name Test',
      });
      const other = await SecurityIntegration.create({
        ...validIntegrationData,
        project: otherProjectId,
        name: 'Cross Project Name Test',
      });
      expect(other._id).toBeDefined();
    });
  });

  describe('SecurityScan Model', () => {
    const validScanData = {
      project: projectId,
      repository: repositoryId,
      pipelineRun: pipelineRunId,
      provider: SECURITY_PROVIDER.TRIVY,
      scanType: SECURITY_SCAN_TYPE.IMAGE,
      target: 'alpine:3.18',
      commitSha: 'a1b2c3d4e5f6',
      branch: 'main',
      status: SECURITY_SCAN_STATUS.PENDING,
      reportDigest: 'sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069',
      summary: {
        critical: 1,
        high: 2,
        medium: 3,
        low: 4,
        negligible: 0,
        unknown: 0,
        total: 10,
      },
      findingCount: 10,
    };

    it('should successfully create a SecurityScan with valid fields', async () => {
      const scan = await SecurityScan.create(validScanData);
      expect(scan._id).toBeDefined();
      expect(scan.status).toBe(SECURITY_SCAN_STATUS.PENDING);
      expect(scan.summary.critical).toBe(1);
      expect(scan.gateStatus).toBeNull();
      expect(scan.startedAt).toBeDefined();
      expect(scan.completedAt).toBeNull();
    });

    it('should allow nullable repository, pipelineRun, and securityIntegration', async () => {
      const scan = await SecurityScan.create({
        project: projectId,
        provider: SECURITY_PROVIDER.TRIVY,
        scanType: SECURITY_SCAN_TYPE.FILESYSTEM,
        target: 'package-lock.json',
        reportDigest: 'digest-nullable-test',
      });
      expect(scan.repository).toBeNull();
      expect(scan.pipelineRun).toBeNull();
      expect(scan.securityIntegration).toBeNull();
    });

    it('should reject invalid scanType and status enum values', async () => {
      const invalidScan = new SecurityScan({
        ...validScanData,
        scanType: 'invalid_type',
      });
      await expect(invalidScan.validate()).rejects.toThrow();

      const invalidStatus = new SecurityScan({
        ...validScanData,
        status: 'invalid_status',
      });
      await expect(invalidStatus.validate()).rejects.toThrow();
    });

    it('should validate gateStatus enum values when provided', async () => {
      const scanWithGate = await SecurityScan.create({
        ...validScanData,
        reportDigest: 'digest-gate-pass',
        gateStatus: POLICY_EVALUATION_STATE.PASS,
      });
      expect(scanWithGate.gateStatus).toBe('PASS');

      const invalidGate = new SecurityScan({
        ...validScanData,
        gateStatus: 'INVALID_GATE_STATUS',
      });
      await expect(invalidGate.validate()).rejects.toThrow();
    });

    it('should NOT enforce a unique constraint on reportDigest globally', async () => {
      const digest = 'sha256:same-report-submitted-twice';
      const scan1 = await SecurityScan.create({
        ...validScanData,
        reportDigest: digest,
      });
      const scan2 = await SecurityScan.create({
        ...validScanData,
        reportDigest: digest,
      });
      expect(scan1._id).toBeDefined();
      expect(scan2._id).toBeDefined();
      expect(scan1._id.toString()).not.toBe(scan2._id.toString());
    });
  });

  describe('SecurityFinding Model', () => {
    let scanId;

    beforeEach(async () => {
      const scan = await SecurityScan.create({
        project: projectId,
        provider: SECURITY_PROVIDER.TRIVY,
        scanType: SECURITY_SCAN_TYPE.IMAGE,
        target: 'alpine:3.18',
        reportDigest: 'digest-findings-test',
      });
      scanId = scan._id;
    });

    const validFindingData = {
      project: projectId,
      repository: repositoryId,
      provider: SECURITY_PROVIDER.TRIVY,
      findingIdentityKey: 'repo123:alpine:3.18:CVE-2023-44487:libcrypto3:vulnerability',
      vulnerabilityId: 'CVE-2023-44487',
      title: 'HTTP/2 Rapid Reset',
      description: 'Stream multiplexing flaw',
      severity: SECURITY_SEVERITY.CRITICAL,
      pkgName: 'libcrypto3',
      installedVersion: '3.1.2-r0',
      fixedVersion: '3.1.4-r0',
      target: 'alpine:3.18',
      findingType: SECURITY_FINDING_TYPE.VULNERABILITY,
      status: SECURITY_FINDING_STATUS.OPEN,
    };

    it('should successfully create a SecurityFinding with valid fields', async () => {
      const finding = await SecurityFinding.create({
        ...validFindingData,
        scan: scanId,
      });
      expect(finding._id).toBeDefined();
      expect(finding.vulnerabilityId).toBe('CVE-2023-44487');
      expect(finding.severity).toBe(SECURITY_SEVERITY.CRITICAL);
      expect(finding.status).toBe(SECURITY_FINDING_STATUS.OPEN);
      expect(finding.firstDetectedAt).toBeDefined();
      expect(finding.resolvedAt).toBeNull();
    });

    it('should validate severity, status, and findingType enums', async () => {
      const invalidSeverity = new SecurityFinding({
        ...validFindingData,
        scan: scanId,
        severity: 'apocalyptic',
      });
      await expect(invalidSeverity.validate()).rejects.toThrow();

      const invalidStatus = new SecurityFinding({
        ...validFindingData,
        scan: scanId,
        status: 'dismissed_forever',
      });
      await expect(invalidStatus.validate()).rejects.toThrow();

      const invalidType = new SecurityFinding({
        ...validFindingData,
        scan: scanId,
        findingType: 'unknown_type',
      });
      await expect(invalidType.validate()).rejects.toThrow();
    });

    it('should support acknowledgement metadata fields', async () => {
      const finding = await SecurityFinding.create({
        ...validFindingData,
        scan: scanId,
        status: SECURITY_FINDING_STATUS.ACKNOWLEDGED,
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
        acknowledgeNote: 'Mitigated by upstream firewall rules',
      });
      expect(finding.status).toBe('acknowledged');
      expect(finding.acknowledgedBy.toString()).toBe(userId.toString());
      expect(finding.acknowledgeNote).toBe('Mitigated by upstream firewall rules');
    });

    it('CRITICAL: findingIdentityKey must NOT be unique across different scans', async () => {
      const secondScan = await SecurityScan.create({
        project: projectId,
        provider: SECURITY_PROVIDER.TRIVY,
        scanType: SECURITY_SCAN_TYPE.IMAGE,
        target: 'alpine:3.18',
        reportDigest: 'digest-second-scan',
      });

      const findingScan1 = await SecurityFinding.create({
        ...validFindingData,
        scan: scanId,
      });

      // Same finding identity in a subsequent historical scan (e.g. still present, or version bumped)
      const findingScan2 = await SecurityFinding.create({
        ...validFindingData,
        scan: secondScan._id,
        installedVersion: '3.1.3-r0', // Version changed, identity key remains identical
      });

      expect(findingScan1._id).toBeDefined();
      expect(findingScan2._id).toBeDefined();
      expect(findingScan1._id.toString()).not.toBe(findingScan2._id.toString());
      expect(findingScan1.findingIdentityKey).toBe(findingScan2.findingIdentityKey);
    });

    it('should allow multiple findings with same identity key within same scan if multi-target', async () => {
      const finding1 = await SecurityFinding.create({
        ...validFindingData,
        scan: scanId,
      });
      const finding2 = await SecurityFinding.create({
        ...validFindingData,
        scan: scanId,
      });
      expect(finding1._id).toBeDefined();
      expect(finding2._id).toBeDefined();
    });
  });

  describe('GovernancePolicy Model', () => {
    it('should successfully create max_severity_count policy with valid config', async () => {
      const policy = await GovernancePolicy.create({
        project: projectId,
        name: 'Zero Critical Vulnerabilities',
        description: 'Block deployment if any critical vulnerability is open',
        ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
        ruleConfig: {
          severity: SECURITY_SEVERITY.CRITICAL,
          maxCount: 0,
        },
        enforcement: POLICY_ENFORCEMENT.BLOCKING,
        createdBy: userId,
      });

      expect(policy._id).toBeDefined();
      expect(policy.name).toBe('Zero Critical Vulnerabilities');
      expect(policy.ruleType).toBe(POLICY_RULE_TYPE.MAX_SEVERITY_COUNT);
      expect(policy.enforcement).toBe(POLICY_ENFORCEMENT.BLOCKING);
      expect(policy.isActive).toBe(true);
    });

    it('should successfully create required_scan policy with valid config', async () => {
      const policy = await GovernancePolicy.create({
        project: projectId,
        name: 'Required Fresh Container Image Scan',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: {
          provider: SECURITY_PROVIDER.TRIVY,
          scanType: SECURITY_SCAN_TYPE.IMAGE,
          maxAgeSeconds: 86400,
        },
        enforcement: POLICY_ENFORCEMENT.BLOCKING,
        createdBy: userId,
      });

      expect(policy._id).toBeDefined();
      expect(policy.ruleConfig.maxAgeSeconds).toBe(86400);
    });

    it('should reject invalid ruleType enum value', async () => {
      const invalid = new GovernancePolicy({
        project: projectId,
        name: 'Invalid Rule Type',
        ruleType: 'license_block', // Intentionally not in active enum in Phase 3
        ruleConfig: {},
        createdBy: userId,
      });
      await expect(invalid.validate()).rejects.toThrow();
    });

    it('should reject invalid ruleConfig for max_severity_count (missing maxCount or invalid severity)', async () => {
      const invalidSeverity = new GovernancePolicy({
        project: projectId,
        name: 'Invalid Severity Rule',
        ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
        ruleConfig: {
          severity: 'catastrophic',
          maxCount: 0,
        },
        createdBy: userId,
      });
      await expect(invalidSeverity.validate()).rejects.toThrow(/Invalid ruleConfig/);

      const invalidCount = new GovernancePolicy({
        project: projectId,
        name: 'Invalid MaxCount Rule',
        ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
        ruleConfig: {
          severity: SECURITY_SEVERITY.HIGH,
          maxCount: -1,
        },
        createdBy: userId,
      });
      await expect(invalidCount.validate()).rejects.toThrow(/Invalid ruleConfig/);
    });

    it('should reject invalid ruleConfig for required_scan (missing maxAgeSeconds or non-positive)', async () => {
      const invalidAge = new GovernancePolicy({
        project: projectId,
        name: 'Invalid Age Rule',
        ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
        ruleConfig: {
          scanType: SECURITY_SCAN_TYPE.IMAGE,
          maxAgeSeconds: -60,
        },
        createdBy: userId,
      });
      await expect(invalidAge.validate()).rejects.toThrow(/Invalid ruleConfig/);
    });

    it('should enforce unique compound index on { project, name }', async () => {
      await GovernancePolicy.create({
        project: projectId,
        name: 'Unique Policy Name',
        ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
        ruleConfig: { severity: SECURITY_SEVERITY.CRITICAL, maxCount: 0 },
        createdBy: userId,
      });

      await expect(
        GovernancePolicy.create({
          project: projectId,
          name: 'Unique Policy Name',
          ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
          ruleConfig: { severity: SECURITY_SEVERITY.CRITICAL, maxCount: 0 },
          createdBy: userId,
        })
      ).rejects.toThrow(/duplicate key/i);
    });
  });

  describe('PolicyGateResult Model', () => {
    let scanId;
    let policyId;

    beforeEach(async () => {
      const scan = await SecurityScan.create({
        project: projectId,
        provider: SECURITY_PROVIDER.TRIVY,
        scanType: SECURITY_SCAN_TYPE.IMAGE,
        target: 'alpine:3.18',
        reportDigest: 'digest-gate-result-test',
      });
      scanId = scan._id;

      const policy = await GovernancePolicy.create({
        project: projectId,
        name: 'No High CVEs',
        ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
        ruleConfig: { severity: SECURITY_SEVERITY.HIGH, maxCount: 0 },
        enforcement: POLICY_ENFORCEMENT.BLOCKING,
        createdBy: userId,
      });
      policyId = policy._id;
    });

    const validGateResultData = {
      project: projectId,
      policyName: 'No High CVEs',
      ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
      enforcement: POLICY_ENFORCEMENT.BLOCKING,
      passed: true,
      evaluationStatus: POLICY_EVALUATION_STATE.PASS,
      reason: 'Found 0 open high vulnerabilities (limit: 0)',
      evaluatedData: { count: 0, limit: 0 },
    };

    it('should successfully create a PolicyGateResult with valid fields', async () => {
      const result = await PolicyGateResult.create({
        ...validGateResultData,
        scan: scanId,
        policy: policyId,
        pipelineRun: pipelineRunId,
      });

      expect(result._id).toBeDefined();
      expect(result.passed).toBe(true);
      expect(result.evaluationStatus).toBe('PASS');
      expect(result.isOverridden).toBe(false);
      expect(result.overrideStatus).toBeNull();
    });

    it('should enforce unique compound index on { scan, policy }', async () => {
      await PolicyGateResult.create({
        ...validGateResultData,
        scan: scanId,
        policy: policyId,
      });

      await expect(
        PolicyGateResult.create({
          ...validGateResultData,
          scan: scanId,
          policy: policyId,
        })
      ).rejects.toThrow(/duplicate key/i);
    });

    it('should validate evaluationStatus enum', async () => {
      const invalid = new PolicyGateResult({
        ...validGateResultData,
        scan: scanId,
        policy: policyId,
        evaluationStatus: 'INVALID_STATUS',
      });
      await expect(invalid.validate()).rejects.toThrow();
    });

    it('CRITICAL: non-destructive override must preserve original passed=false and evaluationStatus=FAIL', async () => {
      // 1. Create a failed gate result
      const failedResult = await PolicyGateResult.create({
        ...validGateResultData,
        scan: scanId,
        policy: policyId,
        passed: false,
        evaluationStatus: POLICY_EVALUATION_STATE.FAIL,
        reason: 'Found 3 open high vulnerabilities (exceeds limit: 0)',
        evaluatedData: { count: 3, limit: 0 },
      });

      expect(failedResult.passed).toBe(false);
      expect(failedResult.evaluationStatus).toBe('FAIL');

      // 2. Apply manual override
      failedResult.isOverridden = true;
      failedResult.overrideStatus = 'approved';
      failedResult.overriddenBy = userId;
      failedResult.overriddenAt = new Date();
      failedResult.overrideJustification = 'Emergency hotfix deployment approved by Security Lead';
      failedResult.originalGateState = {
        passed: false,
        evaluationStatus: 'FAIL',
        reason: failedResult.reason,
      };
      await failedResult.save();

      // 3. Verify in DB: original evaluation is NOT mutated to passed=true
      const updated = await PolicyGateResult.findById(failedResult._id);
      expect(updated.passed).toBe(false); // MUST REMAIN FALSE
      expect(updated.evaluationStatus).toBe('FAIL'); // MUST REMAIN FAIL
      expect(updated.isOverridden).toBe(true);
      expect(updated.overrideStatus).toBe('approved');
      expect(updated.overrideJustification).toBe(
        'Emergency hotfix deployment approved by Security Lead'
      );
      expect(updated.originalGateState.passed).toBe(false);
      expect(updated.originalGateState.evaluationStatus).toBe('FAIL');
    });
  });
});

import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../../app.js';
import Issue from '../../issues/issue.model.js';
import PipelineRun from '../../cicd/pipelineRun.model.js';
import SecurityScan from '../securityScan.model.js';
import GovernancePolicy from '../governancePolicy.model.js';
import PolicyGateResult from '../policyGateResult.model.js';
import SecurityDeliveryStateService from '../securityDeliveryState.service.js';
import { createTestUser, createTestProject } from '../../../../tests/helpers.js';
import AuthService from '../../auth/auth.service.js';
import {
  SECURITY_SCAN_STATUS,
  SECURITY_DELIVERY_STATUS,
  POLICY_EVALUATION_STATE,
  POLICY_RULE_TYPE,
  POLICY_ENFORCEMENT,
} from '../../../shared/constants.js';

describe('Phase 3 Step 6 — Authoritative Unified Delivery State Projection', () => {
  let user;
  let authCookie;
  let project;
  let issue;
  const issueKey = 'PROJ-101';

  beforeEach(async () => {
    const userRes = await createTestUser();
    user = userRes.user;

    const token = AuthService.generateToken(user);
    authCookie = [`udp_token=${token}; Path=/; HttpOnly`];

    project = await createTestProject(user._id, { key: 'PROJ', name: 'Project Service' });

    issue = await Issue.create({
      project: project._id,
      issueKey,
      issueNumber: 101,
      title: 'Implement OAuth authentication',
      status: 'in_progress',
      priority: 'high',
      type: 'feature',
      reporter: user._id,
    });
  });

  // Helper to create a pipeline run linked to the issue
  async function createPipelineRun(overrides = {}) {
    return PipelineRun.create({
      project: project._id,
      repository: new mongoose.Types.ObjectId(),
      provider: 'github_actions',
      externalRunId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      workflowName: 'CI Build & Test',
      runNumber: 1,
      status: 'completed',
      conclusion: 'success',
      branch: 'feature/oauth',
      commitSha: 'a1b2c3d4e5f6',
      matchedIssueKeys: [issueKey],
      ...overrides,
    });
  }

  // Helper to create a SecurityScan
  async function createScan(pipelineRunId, overrides = {}) {
    return SecurityScan.create({
      project: project._id,
      repository: new mongoose.Types.ObjectId(),
      pipelineRun: pipelineRunId,
      securityIntegration: new mongoose.Types.ObjectId(),
      provider: 'trivy',
      scanType: 'image',
      target: 'node:20-alpine',
      reportDigest: `digest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status: SECURITY_SCAN_STATUS.COMPLETED,
      summary: { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0, total: 0 },
      findingCount: 0,
      completedAt: new Date(),
      ...overrides,
    });
  }

  // =========================================================================
  // SECTION 14 TESTS: DELIVERY STATE CASES A - K
  // =========================================================================

  it('A. No security scan: → NOT_STARTED', async () => {
    // PipelineRun exists with matchedIssueKeys, but NO SecurityScan created
    await createPipelineRun();

    const result = await SecurityDeliveryStateService.getIssueSecurityProjection(
      project._id,
      issueKey
    );

    expect(result.security.status).toBe(SECURITY_DELIVERY_STATUS.NOT_STARTED);
    expect(result.security.latestScan).toBeNull();
    expect(result.security.findingsSummary).toBeNull();
    expect(result.security.gateStatus).toBeNull();
    expect(result.traceability.matchedPipelineRuns).toBe(1);
    expect(result.traceability.associatedScanId).toBeNull();
  });

  it('B. Processing scan: → PROCESSING', async () => {
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      status: SECURITY_SCAN_STATUS.PROCESSING,
      completedAt: null,
    });

    const result = await SecurityDeliveryStateService.getIssueSecurityProjection(
      project._id,
      issueKey
    );

    expect(result.security.status).toBe(SECURITY_DELIVERY_STATUS.PROCESSING);
    expect(result.security.scanStatus).toBe('processing');
    expect(result.security.latestScan._id.toString()).toBe(scan._id.toString());
    expect(result.governance.status).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
  });

  it('C. Completed scan + passing policies: → PASSED', async () => {
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.PASS,
    });

    const policy = await GovernancePolicy.create({
      project: project._id,
      name: 'max-critical-zero',
      ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
      ruleConfig: { severity: 'critical', maxCount: 0 },
      enforcement: POLICY_ENFORCEMENT.BLOCKING,
      createdBy: user._id,
      isActive: true,
    });

    await PolicyGateResult.create({
      project: project._id,
      scan: scan._id,
      policy: policy._id,
      policyName: policy.name,
      ruleType: policy.ruleType,
      enforcement: policy.enforcement,
      passed: true,
      evaluationStatus: POLICY_EVALUATION_STATE.PASS,
      reason: '0 critical findings within threshold (max: 0)',
    });

    const result = await SecurityDeliveryStateService.getIssueSecurityProjection(
      project._id,
      issueKey
    );

    expect(result.security.status).toBe(SECURITY_DELIVERY_STATUS.PASSED);
    expect(result.security.gateStatus).toBe(POLICY_EVALUATION_STATE.PASS);
    expect(result.governance.status).toBe(POLICY_EVALUATION_STATE.PASS);
    expect(result.governance.passed).toBe(1);
    expect(result.governance.blockingFailures).toBe(0);
  });

  it('D. Completed scan + blocking policy failure: → FAILED', async () => {
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.FAIL,
      summary: { critical: 2, high: 1, medium: 0, low: 0, negligible: 0, unknown: 0, total: 3 },
      findingCount: 3,
    });

    const policy = await GovernancePolicy.create({
      project: project._id,
      name: 'zero-critical-blocking',
      ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
      ruleConfig: { severity: 'critical', maxCount: 0 },
      enforcement: POLICY_ENFORCEMENT.BLOCKING,
      createdBy: user._id,
      isActive: true,
    });

    await PolicyGateResult.create({
      project: project._id,
      scan: scan._id,
      policy: policy._id,
      policyName: policy.name,
      ruleType: policy.ruleType,
      enforcement: policy.enforcement,
      passed: false,
      evaluationStatus: POLICY_EVALUATION_STATE.FAIL,
      reason: 'critical findings (2) exceed threshold (max: 0)',
    });

    const result = await SecurityDeliveryStateService.getIssueSecurityProjection(
      project._id,
      issueKey
    );

    expect(result.security.status).toBe(SECURITY_DELIVERY_STATUS.FAILED);
    expect(result.security.gateStatus).toBe(POLICY_EVALUATION_STATE.FAIL);
    expect(result.governance.status).toBe(POLICY_EVALUATION_STATE.FAIL);
    expect(result.governance.blockingFailures).toBe(1);
  });

  it('E. Warning-only policy: → PASSED with gateStatus=WARNING', async () => {
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.WARNING,
      summary: { critical: 0, high: 0, medium: 4, low: 0, negligible: 0, unknown: 0, total: 4 },
      findingCount: 4,
    });

    const policy = await GovernancePolicy.create({
      project: project._id,
      name: 'warn-medium-threshold',
      ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
      ruleConfig: { severity: 'medium', maxCount: 0 },
      enforcement: POLICY_ENFORCEMENT.WARNING,
      createdBy: user._id,
      isActive: true,
    });

    await PolicyGateResult.create({
      project: project._id,
      scan: scan._id,
      policy: policy._id,
      policyName: policy.name,
      ruleType: policy.ruleType,
      enforcement: policy.enforcement,
      passed: false,
      evaluationStatus: POLICY_EVALUATION_STATE.WARNING,
      reason: 'medium findings (4) exceed advisory threshold (max: 0)',
    });

    const result = await SecurityDeliveryStateService.getIssueSecurityProjection(
      project._id,
      issueKey
    );

    // Warning policy does NOT block delivery
    expect(result.security.status).toBe(SECURITY_DELIVERY_STATUS.PASSED);
    expect(result.security.gateStatus).toBe(POLICY_EVALUATION_STATE.WARNING);
    expect(result.governance.status).toBe(POLICY_EVALUATION_STATE.WARNING);
    expect(result.governance.warnings).toBe(1);
    expect(result.governance.blockingFailures).toBe(0);
  });

  it('F. Not evaluated: → NOT_EVALUATED', async () => {
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.NOT_EVALUATED,
    });

    const policy = await GovernancePolicy.create({
      project: project._id,
      name: 'require-config-scan',
      ruleType: POLICY_RULE_TYPE.REQUIRED_SCAN,
      ruleConfig: { scanType: 'config', maxAgeSeconds: 86400 },
      enforcement: POLICY_ENFORCEMENT.BLOCKING,
      createdBy: user._id,
      isActive: true,
    });

    await PolicyGateResult.create({
      project: project._id,
      scan: scan._id,
      policy: policy._id,
      policyName: policy.name,
      ruleType: policy.ruleType,
      enforcement: policy.enforcement,
      passed: false,
      evaluationStatus: POLICY_EVALUATION_STATE.NOT_EVALUATED,
      reason: 'No completed config scan found',
    });

    const result = await SecurityDeliveryStateService.getIssueSecurityProjection(
      project._id,
      issueKey
    );

    expect(result.security.status).toBe(SECURITY_DELIVERY_STATUS.NOT_EVALUATED);
    expect(result.governance.status).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
    expect(result.governance.notEvaluated).toBe(1);
  });

  it('G. System error: → ERROR', async () => {
    const run = await createPipelineRun();
    // Scan failed at infrastructure/parsing stage
    await createScan(run._id, {
      status: SECURITY_SCAN_STATUS.FAILED,
      errorMessage: 'Trivy report JSON payload parse error: unexpected token',
    });

    const result = await SecurityDeliveryStateService.getIssueSecurityProjection(
      project._id,
      issueKey
    );

    expect(result.security.status).toBe(SECURITY_DELIVERY_STATUS.ERROR);
    expect(result.security.scanStatus).toBe('failed');
    expect(result.security.latestScan.errorMessage).toContain('parse error');
  });

  it('H. Scan without PipelineRun: → not falsely linked to an Issue', async () => {
    // Scan created directly without a pipelineRun (e.g. ad-hoc or registry scan)
    const scanWithoutPipeline = await createScan(null, {
      target: 'unattached-image:latest',
      gateStatus: POLICY_EVALUATION_STATE.PASS,
    });

    const result = await SecurityDeliveryStateService.getIssueSecurityProjection(
      project._id,
      issueKey
    );

    // Issue has NO matching pipeline runs, so unattached scan must NOT be linked
    expect(result.security.status).toBe(SECURITY_DELIVERY_STATUS.NOT_STARTED);
    expect(result.traceability.associatedScanId).toBeNull();
    expect(scanWithoutPipeline.pipelineRun).toBeNull();
  });

  it('I. SecurityScan with PipelineRun whose matchedIssueKeys contains issue: → correct Issue delivery projection', async () => {
    const run = await createPipelineRun({
      matchedIssueKeys: ['OTHER-99', issueKey],
    });
    const scan = await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.PASS,
      target: 'api-service:v1.2.0',
    });

    const result = await SecurityDeliveryStateService.getIssueSecurityProjection(
      project._id,
      issueKey
    );

    expect(result.security.status).toBe(SECURITY_DELIVERY_STATUS.PASSED);
    expect(result.traceability.associatedScanId.toString()).toBe(scan._id.toString());
    expect(result.security.latestScan.target).toBe('api-service:v1.2.0');
  });

  it('J. Multiple historical scans: → latest relevant authoritative scan selected', async () => {
    const olderRun = await createPipelineRun({
      startedAt: new Date(Date.now() - 3600000),
      createdAt: new Date(Date.now() - 3600000),
    });
    const newerRun = await createPipelineRun({
      startedAt: new Date(),
      createdAt: new Date(),
    });

    // Older scan
    await createScan(olderRun._id, {
      target: 'older-scan:v1.0',
      createdAt: new Date(Date.now() - 3600000),
      gateStatus: POLICY_EVALUATION_STATE.FAIL,
    });

    // Newer scan
    const newerScan = await createScan(newerRun._id, {
      target: 'newer-scan:v2.0',
      createdAt: new Date(),
      gateStatus: POLICY_EVALUATION_STATE.PASS,
    });

    const result = await SecurityDeliveryStateService.getIssueSecurityProjection(
      project._id,
      issueKey
    );

    // Must pick newer scan
    expect(result.traceability.associatedScanId.toString()).toBe(newerScan._id.toString());
    expect(result.security.latestScan.target).toBe('newer-scan:v2.0');
    expect(result.security.status).toBe(SECURITY_DELIVERY_STATUS.PASSED);
  });

  it('K. Multiple policies: → aggregate result comes from PolicyEngine result, not duplicated logic', async () => {
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.FAIL,
    });

    // 1 blocking FAIL + 1 WARNING policy
    const policy1 = await GovernancePolicy.create({
      project: project._id,
      name: 'policy-fail',
      ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
      ruleConfig: { severity: 'high', maxCount: 0 },
      enforcement: POLICY_ENFORCEMENT.BLOCKING,
      createdBy: user._id,
      isActive: true,
    });

    const policy2 = await GovernancePolicy.create({
      project: project._id,
      name: 'policy-warn',
      ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
      ruleConfig: { severity: 'low', maxCount: 0 },
      enforcement: POLICY_ENFORCEMENT.WARNING,
      createdBy: user._id,
      isActive: true,
    });

    await PolicyGateResult.create({
      project: project._id,
      scan: scan._id,
      policy: policy1._id,
      policyName: policy1.name,
      ruleType: policy1.ruleType,
      enforcement: policy1.enforcement,
      passed: false,
      evaluationStatus: POLICY_EVALUATION_STATE.FAIL,
      reason: 'Failed blocking policy',
    });

    await PolicyGateResult.create({
      project: project._id,
      scan: scan._id,
      policy: policy2._id,
      policyName: policy2.name,
      ruleType: policy2.ruleType,
      enforcement: policy2.enforcement,
      passed: false,
      evaluationStatus: POLICY_EVALUATION_STATE.WARNING,
      reason: 'Failed warning policy',
    });

    const result = await SecurityDeliveryStateService.getIssueSecurityProjection(
      project._id,
      issueKey
    );

    expect(result.governance.blockingFailures).toBe(1);
    expect(result.governance.warnings).toBe(1);
    expect(result.governance.status).toBe(POLICY_EVALUATION_STATE.FAIL);
    expect(result.security.status).toBe(SECURITY_DELIVERY_STATUS.FAILED);
  });

  // =========================================================================
  // HTTP ENDPOINT: GET /api/v1/projects/:projectId/issues/:issueKey/delivery-state
  // =========================================================================
  describe('HTTP Delivery State Endpoint', () => {
    it('returns 200 and unified delivery state with security & governance stages', async () => {
      const run = await createPipelineRun();
      await createScan(run._id, {
        gateStatus: POLICY_EVALUATION_STATE.PASS,
      });

      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.issueKey).toBe(issueKey);
      expect(data.issue._id.toString()).toBe(issue._id.toString());

      // Stages verification
      expect(data.stages.issue).toBeDefined();
      expect(data.stages.branch).toBeDefined();
      expect(data.stages.commit).toBeDefined();
      expect(data.stages.pr).toBeDefined();
      expect(data.stages.ci).toBeDefined();
      expect(data.stages.security).toBeDefined();
      expect(data.stages.governance).toBeDefined();

      // Security stage details
      expect(data.stages.security.status).toBe(SECURITY_DELIVERY_STATUS.PASSED);
      expect(data.security.status).toBe(SECURITY_DELIVERY_STATUS.PASSED);
      expect(data.governance.status).toBe(POLICY_EVALUATION_STATE.PASS);
    });

    it('returns 404 for non-existent issueKey', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/NONEXISTENT-999/delivery-state`)
        .set('Cookie', authCookie);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 when unauthorized / missing auth token', async () => {
      const res = await request(app).get(
        `/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`
      );

      expect(res.status).toBe(401);
    });
  });
});

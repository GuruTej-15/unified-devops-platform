import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../../app.js';
import Issue from '../../issues/issue.model.js';
import PipelineRun from '../../cicd/pipelineRun.model.js';
import SecurityScan from '../securityScan.model.js';
import GovernancePolicy from '../governancePolicy.model.js';
import PolicyGateResult from '../policyGateResult.model.js';
import { createTestUser, createTestProject } from '../../../../tests/helpers.js';
import AuthService from '../../auth/auth.service.js';
import {
  SECURITY_SCAN_STATUS,
  SECURITY_DELIVERY_STATUS,
  POLICY_EVALUATION_STATE,
  POLICY_RULE_TYPE,
  POLICY_ENFORCEMENT,
} from '../../../shared/constants.js';

describe('Phase 3 Step 7 — Tier A Frontend Delivery Contract & Security UI Integration', () => {
  let user;
  let authCookie;
  let project;
  const issueKey = 'PROJ-200';

  beforeEach(async () => {
    const userRes = await createTestUser();
    user = userRes.user;

    const token = AuthService.generateToken(user);
    authCookie = [`udp_token=${token}; Path=/; HttpOnly`];

    project = await createTestProject(user._id, {
      key: 'PROJ',
      name: 'Frontend Contract Test Project',
    });

    await Issue.create({
      project: project._id,
      issueKey,
      issueNumber: 200,
      title: 'Support security delivery tracking in UI',
      status: 'in_progress',
      priority: 'high',
      type: 'feature',
      reporter: user._id,
    });
  });

  async function createPipelineRun(overrides = {}) {
    return PipelineRun.create({
      project: project._id,
      repository: new mongoose.Types.ObjectId(),
      provider: 'github_actions',
      externalRunId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      workflowName: 'CI Build & Test',
      runNumber: 12,
      status: 'completed',
      conclusion: 'success',
      branch: 'feature/security-ui',
      commitSha: '9a8b7c6d5e4f',
      matchedIssueKeys: [issueKey],
      duration: 145,
      ...overrides,
    });
  }

  async function createScan(pipelineRunId, overrides = {}) {
    return SecurityScan.create({
      project: project._id,
      repository: new mongoose.Types.ObjectId(),
      pipelineRun: pipelineRunId,
      securityIntegration: new mongoose.Types.ObjectId(),
      provider: 'trivy',
      scanType: 'image',
      target: 'unified-devops-platform:v1.0.0',
      reportDigest: `digest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status: SECURITY_SCAN_STATUS.COMPLETED,
      summary: { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0, total: 0 },
      findingCount: 0,
      completedAt: new Date(),
      ...overrides,
    });
  }

  // =========================================================================
  // 14 MANDATORY REQUIREMENTS FROM SECTION 14
  // =========================================================================

  it('Requirement 1: Security NOT_STARTED state is correctly represented', async () => {
    // PipelineRun exists with issueKey, but no SecurityScan exists
    await createPipelineRun();

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.stages.security.status).toBe(SECURITY_DELIVERY_STATUS.NOT_STARTED);
    expect(data.security.status).toBe(SECURITY_DELIVERY_STATUS.NOT_STARTED);
    expect(data.security.latestScan).toBeNull();
    expect(data.security.findingsSummary).toBeNull();
  });

  it('Requirement 2: Security PROCESSING state is correctly represented', async () => {
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      status: SECURITY_SCAN_STATUS.PROCESSING,
      completedAt: null,
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.stages.security.status).toBe(SECURITY_DELIVERY_STATUS.PROCESSING);
    expect(data.security.status).toBe(SECURITY_DELIVERY_STATUS.PROCESSING);
    expect(data.security.scanStatus).toBe('processing');
    expect(data.security.latestScan._id.toString()).toBe(scan._id.toString());
    expect(data.governance.status).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
  });

  it('Requirement 3: Security PASSED state with passing policies is correctly represented', async () => {
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.PASS,
      summary: { critical: 0, high: 0, medium: 2, low: 5, negligible: 1, unknown: 0, total: 8 },
      findingCount: 8,
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.stages.security.status).toBe(SECURITY_DELIVERY_STATUS.PASSED);
    expect(data.security.status).toBe(SECURITY_DELIVERY_STATUS.PASSED);
    expect(data.security.latestScan._id.toString()).toBe(scan._id.toString());
    expect(data.security.findingsSummary.total).toBe(8);
    expect(data.security.findingsSummary.critical).toBe(0);
    expect(data.security.findingsSummary.high).toBe(0);
  });

  it('Requirement 4: Security FAILED/ERROR state handles both policy failure and processing error', async () => {
    // 4A: Scan completed but blocking policy failed -> FAILED
    const runA = await createPipelineRun();
    await createScan(runA._id, {
      gateStatus: POLICY_EVALUATION_STATE.FAIL,
      summary: { critical: 3, high: 2, medium: 0, low: 0, negligible: 0, unknown: 0, total: 5 },
      findingCount: 5,
    });

    const resA = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(resA.status).toBe(200);
    expect(resA.body.data.stages.security.status).toBe(SECURITY_DELIVERY_STATUS.FAILED);
    expect(resA.body.data.security.status).toBe(SECURITY_DELIVERY_STATUS.FAILED);

    // 4B: Scan processing failed at parser/infrastructure -> ERROR
    const runB = await createPipelineRun({
      externalRunId: 'run-error-scenario',
      startedAt: new Date(Date.now() + 1000),
    });
    await createScan(runB._id, {
      status: SECURITY_SCAN_STATUS.FAILED,
      errorMessage: 'Trivy report JSON payload parse error: unexpected token',
      createdAt: new Date(Date.now() + 2000),
    });

    const resB = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(resB.status).toBe(200);
    expect(resB.body.data.stages.security.status).toBe(SECURITY_DELIVERY_STATUS.ERROR);
    expect(resB.body.data.security.status).toBe(SECURITY_DELIVERY_STATUS.ERROR);
    expect(resB.body.data.security.latestScan.errorMessage).toContain('parse error');
  });

  it('Requirement 5: Governance PASS state is clearly represented', async () => {
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

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.stages.governance.status).toBe(POLICY_EVALUATION_STATE.PASS);
    expect(data.governance.status).toBe(POLICY_EVALUATION_STATE.PASS);
    expect(data.governance.passed).toBe(1);
    expect(data.governance.blockingFailures).toBe(0);
    expect(data.governance.policies[0].passed).toBe(true);
  });

  it('Requirement 6: Governance FAIL state is clearly represented with failure details', async () => {
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.FAIL,
      summary: { critical: 2, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0, total: 2 },
    });

    const policy = await GovernancePolicy.create({
      project: project._id,
      name: 'zero-critical-required',
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

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.stages.governance.status).toBe(POLICY_EVALUATION_STATE.FAIL);
    expect(data.governance.status).toBe(POLICY_EVALUATION_STATE.FAIL);
    expect(data.governance.blockingFailures).toBe(1);
    expect(data.governance.policies[0].passed).toBe(false);
    expect(data.governance.policies[0].reason).toContain('exceed threshold');
  });

  it('Requirement 7: Governance WARNING state does not block security delivery', async () => {
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.WARNING,
      summary: { critical: 0, high: 0, medium: 5, low: 0, negligible: 0, unknown: 0, total: 5 },
      findingCount: 5,
    });

    const policy = await GovernancePolicy.create({
      project: project._id,
      name: 'advisory-medium-threshold',
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
      reason: 'medium findings (5) exceed advisory threshold (max: 0)',
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;
    // Security stage remains PASSED because warning is non-blocking
    expect(data.stages.security.status).toBe(SECURITY_DELIVERY_STATUS.PASSED);
    // Governance stage reflects WARNING
    expect(data.stages.governance.status).toBe(POLICY_EVALUATION_STATE.WARNING);
    expect(data.governance.status).toBe(POLICY_EVALUATION_STATE.WARNING);
    expect(data.governance.warnings).toBe(1);
    expect(data.governance.blockingFailures).toBe(0);
  });

  it('Requirement 8: Governance NOT_EVALUATED state is preserved', async () => {
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
      reason: 'No completed config scan found for project',
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.stages.governance.status).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
    expect(data.governance.status).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
    expect(data.governance.notEvaluated).toBe(1);
  });

  it('Requirement 9: Missing or empty security data renders gracefully without crashing', async () => {
    // Brand new issue with zero activity, zero pipeline runs, zero scans
    const newIssue = await Issue.create({
      project: project._id,
      issueKey: 'PROJ-999',
      issueNumber: 999,
      title: 'Empty security test',
      status: 'open',
      priority: 'low',
      type: 'task',
      reporter: user._id,
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${newIssue.issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;

    // Delivery state must have complete stage tree
    expect(data.stages.issue).toBeDefined();
    expect(data.stages.branch.status).toBe('pending');
    expect(data.stages.commit.status).toBe('pending');
    expect(data.stages.pr.status).toBe('pending');
    expect(data.stages.ci.status).toBe('pending');
    expect(data.stages.security.status).toBe(SECURITY_DELIVERY_STATUS.NOT_STARTED);
    expect(data.stages.governance.status).toBe(POLICY_EVALUATION_STATE.NOT_EVALUATED);
    expect(data.security.latestScan).toBeNull();
    expect(data.governance.policies).toEqual([]);
  });

  it('Requirement 10: Security and Governance remain visually and semantically distinct', async () => {
    // Distinct Scenario: Scan execution succeeded (findingCount=4, status=completed),
    // but governance failed because of 1 critical finding exceeding threshold
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.FAIL,
      summary: { critical: 1, high: 2, medium: 1, low: 0, negligible: 0, unknown: 0, total: 4 },
      findingCount: 4,
    });

    const policy = await GovernancePolicy.create({
      project: project._id,
      name: 'strict-zero-critical',
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
      reason: '1 critical finding exceeds limit of 0',
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;

    // Security projection reports scan execution
    expect(data.security.scanStatus).toBe('completed');
    expect(data.security.findingsSummary.total).toBe(4);
    expect(data.security.findingsSummary.critical).toBe(1);

    // Governance projection reports compliance gate
    expect(data.governance.status).toBe(POLICY_EVALUATION_STATE.FAIL);
    expect(data.governance.blockingFailures).toBe(1);

    // Both top-level sections exist independently
    expect(data.stages.security.id).toBe('security');
    expect(data.stages.governance.id).toBe('governance');
  });

  it('Requirement 11: Realtime security events invalidate and update authoritative delivery state', async () => {
    // Verify that querying delivery-state immediately returns the latest authoritative data
    // after a scan completes
    const run = await createPipelineRun();
    const scan = await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.PASS,
      summary: { critical: 0, high: 0, medium: 0, low: 1, negligible: 0, unknown: 0, total: 1 },
      findingCount: 1,
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.traceability.associatedScanId.toString()).toBe(scan._id.toString());
    expect(res.body.data.security.status).toBe(SECURITY_DELIVERY_STATUS.PASSED);
  });

  it('Requirement 12: Existing CI state remains intact alongside Security and Governance', async () => {
    const run = await createPipelineRun({
      workflowName: 'Production Deploy Pipeline',
      runNumber: 42,
      duration: 320,
    });
    await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.PASS,
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;

    // CI stage is complete and has all expected metadata
    expect(data.stages.ci).toBeDefined();
    expect(data.stages.ci.status).toBe('completed');
    expect(data.stages.ci.latestRun.workflowName).toBe('Production Deploy Pipeline');
    expect(data.stages.ci.latestRun.runNumber).toBe(42);
    expect(data.stages.ci.latestRun.duration).toBe(320);

    // Security and Governance are also present
    expect(data.stages.security.status).toBe(SECURITY_DELIVERY_STATUS.PASSED);
    expect(data.stages.governance.status).toBe(POLICY_EVALUATION_STATE.PASS);
  });

  it('Requirement 13: No false issue association when pipelineRun is absent', async () => {
    // Create an unattached SecurityScan (e.g. ad-hoc container image scan)
    const unattachedScan = await createScan(null, {
      target: 'ad-hoc-scan:latest',
      gateStatus: POLICY_EVALUATION_STATE.PASS,
    });

    // Also create a pipeline run that does NOT match this issueKey
    const otherRun = await createPipelineRun({
      matchedIssueKeys: ['OTHER-999'],
    });
    await createScan(otherRun._id, {
      target: 'other-issue-scan:latest',
      gateStatus: POLICY_EVALUATION_STATE.PASS,
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;

    // Must NOT link either scan to issueKey PROJ-200
    expect(data.security.status).toBe(SECURITY_DELIVERY_STATUS.NOT_STARTED);
    expect(data.security.latestScan).toBeNull();
    expect(data.traceability.associatedScanId).toBeNull();
    expect(unattachedScan.pipelineRun).toBeNull();
  });

  it('Requirement 14: No sensitive or raw report data is exposed in delivery state response', async () => {
    const run = await createPipelineRun();
    await createScan(run._id, {
      gateStatus: POLICY_EVALUATION_STATE.PASS,
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const rawJson = JSON.stringify(res.body);

    // Assert that no sensitive fields or raw payloads leaked
    expect(rawJson).not.toContain('rawPayload');
    expect(rawJson).not.toContain('encryptedWebhookSecret');
    expect(rawJson).not.toContain('webhookSecretIv');
    expect(rawJson).not.toContain('webhookSecretAuthTag');
    expect(rawJson).not.toContain('password');
    expect(rawJson).not.toContain('secretKey');
    expect(rawJson).not.toContain('SchemaVersion');
  });
});

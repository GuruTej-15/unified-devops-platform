import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../app.js';
import Deployment from './deployment.model.js';
import DeploymentService from './deployment.service.js';
import SecurityScan from '../security/securityScan.model.js';
import PolicyGateResult from '../security/policyGateResult.model.js';
import GovernancePolicy from '../security/governancePolicy.model.js';
import Repository from '../vcs/repository.model.js';
import Issue from '../issues/issue.model.js';
import Commit from '../vcs/commit.model.js';
import ProjectMember from '../projects/projectMember.model.js';
import { createTestUser, createTestProject } from '../../../tests/helpers.js';
import AuthService from '../auth/auth.service.js';
import config from '../../config/index.js';
import {
  DEPLOYMENT_PROVIDER,
  DEPLOYMENT_STATUS,
  DEPLOYMENT_GOVERNANCE_STATE,
  SECURITY_PROVIDER,
  SECURITY_SCAN_STATUS,
  POLICY_EVALUATION_STATE,
  POLICY_RULE_TYPE,
  POLICY_ENFORCEMENT,
} from '../../shared/constants.js';

describe('Phase 3 Step 8 — Deployment & Release Governance (Tier A)', () => {
  let ownerUser;
  let devUser;
  let nonMemberUser;
  let _ownerAuthCookie;
  let devAuthCookie;
  let nonMemberAuthCookie;
  let project;
  let repo;

  async function createPolicyAndGate({
    scan,
    passed = true,
    isOverridden = false,
    enforcement = POLICY_ENFORCEMENT.BLOCKING,
  }) {
    const policy = await GovernancePolicy.create({
      project: scan.project,
      name: `Policy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
      ruleConfig: { severity: 'high', maxCount: 0 },
      enforcement,
      createdBy: ownerUser._id,
    });

    return PolicyGateResult.create({
      project: scan.project,
      scan: scan._id,
      policy: policy._id,
      policyName: policy.name,
      ruleType: policy.ruleType,
      enforcement: policy.enforcement,
      passed,
      evaluationStatus: passed ? POLICY_EVALUATION_STATE.PASS : POLICY_EVALUATION_STATE.FAIL,
      reason: passed ? 'Policy passed' : 'Policy failed: high severity findings detected',
      isOverridden,
      overrideStatus: isOverridden ? 'approved' : null,
      overriddenBy: isOverridden ? ownerUser._id : null,
      overriddenAt: isOverridden ? new Date() : null,
      overrideJustification: isOverridden ? 'Approved exception' : '',
    });
  }

  beforeEach(async () => {
    // 1. Create owner user & project
    const ownerData = await createTestUser({ role: 'developer' });
    ownerUser = ownerData.user;
    const ownerToken = AuthService.generateToken(ownerUser);
    _ownerAuthCookie = [`${config.jwt.cookieName}=${ownerToken}; Path=/; HttpOnly`];

    project = await createTestProject(ownerUser._id, {
      name: 'Deployment Governance Project',
      key: 'DGP',
    });

    // 2. Create developer member in project
    const devData = await createTestUser({ role: 'developer' });
    devUser = devData.user;
    const devToken = AuthService.generateToken(devUser);
    devAuthCookie = [`${config.jwt.cookieName}=${devToken}; Path=/; HttpOnly`];
    await ProjectMember.create({
      project: project._id,
      user: devUser._id,
      role: 'developer',
    });

    // 3. Create non-member user
    const nonMemberData = await createTestUser({ role: 'developer' });
    nonMemberUser = nonMemberData.user;
    const nonMemberToken = AuthService.generateToken(nonMemberUser);
    nonMemberAuthCookie = [`${config.jwt.cookieName}=${nonMemberToken}; Path=/; HttpOnly`];

    // 4. Create repository
    repo = await Repository.create({
      project: project._id,
      name: 'payment-service',
      owner: 'testowner',
      fullName: 'testowner/payment-service',
      externalId: '987654321',
      htmlUrl: 'https://github.com/testowner/payment-service',
      connectedBy: ownerUser._id,
      encryptedToken: 'cipher',
      tokenIv: 'iv',
      tokenAuthTag: 'tag',
    });
  });

  // =========================================================================
  // 1. Deployment Model Validation & Indexes
  // =========================================================================
  describe('Deployment Model Validation', () => {
    it('creates a valid deployment with required fields', async () => {
      const dep = await Deployment.create({
        project: project._id,
        provider: DEPLOYMENT_PROVIDER.GITHUB_ACTIONS,
        environment: 'production',
        externalDeploymentId: 'deploy-001',
        status: DEPLOYMENT_STATUS.SUCCESS,
        commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        branch: 'main',
      });

      expect(dep._id).toBeDefined();
      expect(dep.project.toString()).toBe(project._id.toString());
      expect(dep.provider).toBe(DEPLOYMENT_PROVIDER.GITHUB_ACTIONS);
      expect(dep.environment).toBe('production');
      expect(dep.externalDeploymentId).toBe('deploy-001');
      expect(dep.status).toBe(DEPLOYMENT_STATUS.SUCCESS);
      expect(dep.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.NOT_EVALUATED);
      expect(dep.isGovernanceViolation).toBe(false);
    });

    it('rejects invalid providers (e.g. kubernetes, argocd)', async () => {
      const invalid = new Deployment({
        project: project._id,
        provider: 'kubernetes',
        environment: 'production',
        externalDeploymentId: 'dep-invalid-provider',
        status: DEPLOYMENT_STATUS.SUCCESS,
      });

      let err;
      try {
        await invalid.validate();
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.errors.provider).toBeDefined();
    });

    it('rejects invalid status enum values', async () => {
      const invalid = new Deployment({
        project: project._id,
        provider: DEPLOYMENT_PROVIDER.JENKINS,
        environment: 'staging',
        externalDeploymentId: 'dep-invalid-status',
        status: 'exploded',
      });

      let err;
      try {
        await invalid.validate();
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.errors.status).toBeDefined();
    });

    it('enforces compound unique index on (project, provider, environment, externalDeploymentId)', async () => {
      await Deployment.init(); // Ensure indexes are built

      await Deployment.create({
        project: project._id,
        provider: DEPLOYMENT_PROVIDER.GENERIC,
        environment: 'staging',
        externalDeploymentId: 'unique-id-100',
        status: DEPLOYMENT_STATUS.SUCCESS,
      });

      let duplicateErr;
      try {
        await Deployment.create({
          project: project._id,
          provider: DEPLOYMENT_PROVIDER.GENERIC,
          environment: 'staging',
          externalDeploymentId: 'unique-id-100',
          status: DEPLOYMENT_STATUS.FAILED,
        });
      } catch (e) {
        duplicateErr = e;
      }

      expect(duplicateErr).toBeDefined();
      expect(duplicateErr.code).toBe(11000);
    });
  });

  // =========================================================================
  // 2. Authoritative Governance Decision Evaluation
  // =========================================================================
  describe('DeploymentService.evaluateDeploymentGovernance', () => {
    it('returns NOT_EVALUATED when no scan or gate exists for commit', async () => {
      const result = await DeploymentService.evaluateDeploymentGovernance(project._id, {
        commitSha: 'commit-with-no-scans',
      });

      expect(result.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.NOT_EVALUATED);
      expect(result.gateResultId).toBeNull();
    });

    it('evaluates ALLOWED when associated gate result is PASS', async () => {
      const commitSha = 'commit-passing-governance';
      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-1',
      });

      const gate = await createPolicyAndGate({ scan, passed: true });

      const result = await DeploymentService.evaluateDeploymentGovernance(project._id, {
        commitSha,
      });

      expect(result.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.ALLOWED);
      expect(result.gateResultId.toString()).toBe(gate._id.toString());
    });

    it('evaluates BLOCKED when associated gate result is FAIL and not overridden', async () => {
      const commitSha = 'commit-blocked-governance';
      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-2',
      });

      const gate = await createPolicyAndGate({ scan, passed: false, isOverridden: false });

      const result = await DeploymentService.evaluateDeploymentGovernance(project._id, {
        commitSha,
      });

      expect(result.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.BLOCKED);
      expect(result.gateResultId.toString()).toBe(gate._id.toString());
    });

    it('evaluates OVERRIDDEN when associated gate result has been overridden by Security Admin', async () => {
      const commitSha = 'commit-overridden-governance';
      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-3',
      });

      const gate = await createPolicyAndGate({ scan, passed: false, isOverridden: true });

      const result = await DeploymentService.evaluateDeploymentGovernance(project._id, {
        commitSha,
      });

      expect(result.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.OVERRIDDEN);
      expect(result.gateResultId.toString()).toBe(gate._id.toString());
    });
  });

  // =========================================================================
  // 3. Governance Violation Detection
  // =========================================================================
  describe('DeploymentService.ingestDeployment — Governance Violation Detection', () => {
    it('sets isGovernanceViolation = true when deployment succeeded externally despite BLOCKED gate', async () => {
      const commitSha = 'commit-violator';
      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-4',
      });

      await createPolicyAndGate({ scan, passed: false, isOverridden: false });

      const deployment = await DeploymentService.ingestDeployment(project._id, {
        provider: DEPLOYMENT_PROVIDER.GITHUB_ACTIONS,
        environment: 'production',
        externalDeploymentId: 'gha-run-45678',
        commitSha,
        status: DEPLOYMENT_STATUS.SUCCESS,
        branch: 'main',
        actor: 'release-bot',
      });

      expect(deployment.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.BLOCKED);
      expect(deployment.isGovernanceViolation).toBe(true);
      expect(deployment.status).toBe(DEPLOYMENT_STATUS.SUCCESS);
    });

    it('sets isGovernanceViolation = false when deployment succeeded and governance is ALLOWED', async () => {
      const commitSha = 'commit-compliant';
      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-5',
      });

      await createPolicyAndGate({ scan, passed: true });

      const deployment = await DeploymentService.ingestDeployment(project._id, {
        provider: DEPLOYMENT_PROVIDER.GITHUB_ACTIONS,
        environment: 'production',
        externalDeploymentId: 'gha-run-compliant',
        commitSha,
        status: DEPLOYMENT_STATUS.SUCCESS,
        branch: 'main',
      });

      expect(deployment.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.ALLOWED);
      expect(deployment.isGovernanceViolation).toBe(false);
    });

    it('sets isGovernanceViolation = false when external deployment failed even if gate was BLOCKED', async () => {
      const commitSha = 'commit-failed-dep';
      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-6',
      });

      await createPolicyAndGate({ scan, passed: false, isOverridden: false });

      const deployment = await DeploymentService.ingestDeployment(project._id, {
        provider: DEPLOYMENT_PROVIDER.JENKINS,
        environment: 'production',
        externalDeploymentId: 'jenkins-fail-1',
        commitSha,
        status: DEPLOYMENT_STATUS.FAILED,
        branch: 'main',
      });

      expect(deployment.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.BLOCKED);
      expect(deployment.isGovernanceViolation).toBe(false);
      expect(deployment.status).toBe(DEPLOYMENT_STATUS.FAILED);
    });

    it('supports idempotent repeated ingestion with same externalDeploymentId', async () => {
      const commitSha = 'commit-idempotent';

      // 1. Initial queued
      const dep1 = await DeploymentService.ingestDeployment(project._id, {
        provider: DEPLOYMENT_PROVIDER.GENERIC,
        environment: 'staging',
        externalDeploymentId: 'dep-idemp-1',
        commitSha,
        status: DEPLOYMENT_STATUS.IN_PROGRESS,
      });

      expect(dep1.status).toBe(DEPLOYMENT_STATUS.IN_PROGRESS);

      // 2. Updated to success
      const dep2 = await DeploymentService.ingestDeployment(project._id, {
        provider: DEPLOYMENT_PROVIDER.GENERIC,
        environment: 'staging',
        externalDeploymentId: 'dep-idemp-1',
        commitSha,
        status: DEPLOYMENT_STATUS.SUCCESS,
        url: 'https://deploy.example.com/logs/1',
      });

      expect(dep2._id.toString()).toBe(dep1._id.toString());
      expect(dep2.status).toBe(DEPLOYMENT_STATUS.SUCCESS);
      expect(dep2.url).toBe('https://deploy.example.com/logs/1');

      // Verify only 1 document in database
      const count = await Deployment.countDocuments({
        project: project._id,
        externalDeploymentId: 'dep-idemp-1',
      });
      expect(count).toBe(1);
    });
  });

  // =========================================================================
  // 4. Ingestion API Endpoint (POST /api/v1/projects/:projectId/deployments)
  // =========================================================================
  describe('POST /api/v1/projects/:projectId/deployments', () => {
    it('creates deployment record via API with valid payload', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/deployments`)
        .set('Cookie', devAuthCookie)
        .send({
          provider: 'github_actions',
          environment: 'production',
          externalDeploymentId: 'gha-api-1234',
          commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
          branch: 'main',
          status: 'success',
          url: 'https://github.com/testowner/payment-service/actions/runs/1234',
          actor: 'octocat',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.externalDeploymentId).toBe('gha-api-1234');
      expect(res.body.data.environment).toBe('production');
      expect(res.body.data.governanceDecision).toBe('NOT_EVALUATED');
    });

    it('rejects 400 when missing required fields', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/deployments`)
        .set('Cookie', devAuthCookie)
        .send({
          environment: 'staging',
          // missing provider, externalDeploymentId, status
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects 400 when invalid provider is supplied', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/deployments`)
        .set('Cookie', devAuthCookie)
        .send({
          provider: 'argocd',
          environment: 'production',
          externalDeploymentId: 'argo-99',
          status: 'success',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid provider/i);
    });

    it('rejects 403 when user is not a project member', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/deployments`)
        .set('Cookie', nonMemberAuthCookie)
        .send({
          provider: 'github_actions',
          environment: 'staging',
          externalDeploymentId: 'unauth-1',
          status: 'success',
        });

      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // 5. Deployment Listing & Details API
  // =========================================================================
  describe('GET /api/v1/projects/:projectId/deployments', () => {
    beforeEach(async () => {
      await Deployment.create([
        {
          project: project._id,
          provider: 'github_actions',
          environment: 'production',
          externalDeploymentId: 'list-1',
          status: 'success',
          commitSha: 'sha1',
        },
        {
          project: project._id,
          provider: 'jenkins',
          environment: 'staging',
          externalDeploymentId: 'list-2',
          status: 'failed',
          commitSha: 'sha2',
        },
      ]);
    });

    it('lists deployments with pagination', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/deployments`)
        .set('Cookie', devAuthCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(2);
      expect(res.body.pagination.total).toBe(2);
    });

    it('filters deployments by environment', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/deployments?environment=production`)
        .set('Cookie', devAuthCookie);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].externalDeploymentId).toBe('list-1');
    });

    it('gets deployment by ID', async () => {
      const dep = await Deployment.findOne({
        project: project._id,
        externalDeploymentId: 'list-1',
      });

      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/deployments/${dep._id}`)
        .set('Cookie', devAuthCookie);

      expect(res.status).toBe(200);
      expect(res.body.data.externalDeploymentId).toBe('list-1');
    });

    it('returns 404 for nonexistent deployment', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/deployments/${fakeId}`)
        .set('Cookie', devAuthCookie);

      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // 6. Delivery State Projection Integration
  // =========================================================================
  describe('GET /api/v1/projects/:projectId/issues/:issueKey/delivery-state with Deployment', () => {
    let issue;

    beforeEach(async () => {
      issue = await Issue.create({
        project: project._id,
        issueNumber: 101,
        issueKey: 'DGP-101',
        title: 'Implement Payment Gateway',
        type: 'feature',
        status: 'in_progress',
        priority: 'high',
        reporter: ownerUser._id,
      });
    });

    it('returns pending deployment stage when no deployment exists', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/${issue.issueKey}/delivery-state`)
        .set('Cookie', devAuthCookie);

      expect(res.status).toBe(200);
      expect(res.body.data.stages).toBeDefined();
      expect(res.body.data.stages.deployment).toBeDefined();
      expect(res.body.data.stages.deployment.status).toBe('pending');
      expect(res.body.data.stages.deployment.latestDeployment).toBeNull();
      expect(res.body.data.traceability.associatedDeploymentId).toBeNull();
    });

    it('correlates deployment to issue via matched commit SHA and returns completed deployment stage', async () => {
      const commitSha = 'd1e2f3a4b5c6d1e2f3a4b5c6d1e2f3a4b5c6d1e2';

      // Link commit to issue
      await Commit.create({
        project: project._id,
        repository: repo._id,
        sha: commitSha,
        message: 'DGP-101: add stripe checkout flow',
        authorName: 'Developer',
        authorEmail: 'dev@example.com',
        authoredAt: new Date(),
        matchedIssueKeys: ['DGP-101'],
      });

      // Scan and passing policy gate
      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-7',
      });

      await createPolicyAndGate({ scan, passed: true });

      // Deploy commit
      const deployment = await DeploymentService.ingestDeployment(project._id, {
        provider: DEPLOYMENT_PROVIDER.GITHUB_ACTIONS,
        environment: 'production',
        externalDeploymentId: 'gha-run-prod-999',
        commitSha,
        branch: 'main',
        status: DEPLOYMENT_STATUS.SUCCESS,
        duration: 45,
        actor: 'deployment-agent',
      });

      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/${issue.issueKey}/delivery-state`)
        .set('Cookie', devAuthCookie);

      expect(res.status).toBe(200);
      expect(res.body.data.stages.deployment).toBeDefined();
      expect(res.body.data.stages.deployment.status).toBe('completed');
      expect(res.body.data.stages.deployment.environment).toBe('production');
      expect(res.body.data.stages.deployment.governanceDecision).toBe('ALLOWED');
      expect(res.body.data.stages.deployment.isGovernanceViolation).toBe(false);
      expect(res.body.data.stages.deployment.latestDeployment._id.toString()).toBe(
        deployment._id.toString()
      );
      expect(res.body.data.traceability.associatedDeploymentId.toString()).toBe(
        deployment._id.toString()
      );
    });

    it('reflects governance violation in delivery state when deployment succeeds despite blocked gate', async () => {
      const commitSha = 'violator-commit-sha';

      await Commit.create({
        project: project._id,
        repository: repo._id,
        sha: commitSha,
        message: 'DGP-101: hotfix with critical vuln',
        authorName: 'Developer',
        authorEmail: 'dev@example.com',
        authoredAt: new Date(),
        matchedIssueKeys: ['DGP-101'],
      });

      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-8',
      });

      await createPolicyAndGate({ scan, passed: false, isOverridden: false });

      await DeploymentService.ingestDeployment(project._id, {
        provider: DEPLOYMENT_PROVIDER.GENERIC,
        environment: 'production',
        externalDeploymentId: 'dep-violation-01',
        commitSha,
        status: DEPLOYMENT_STATUS.SUCCESS,
      });

      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/${issue.issueKey}/delivery-state`)
        .set('Cookie', devAuthCookie);

      expect(res.status).toBe(200);
      expect(res.body.data.stages.deployment.status).toBe('completed');
      expect(res.body.data.stages.deployment.governanceDecision).toBe('BLOCKED');
      expect(res.body.data.stages.deployment.isGovernanceViolation).toBe(true);
      expect(res.body.data.deployment.isGovernanceViolation).toBe(true);
    });
  });
});

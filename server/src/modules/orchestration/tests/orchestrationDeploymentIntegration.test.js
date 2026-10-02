import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../../../app.js';
import { createTestUser, createTestProject } from '../../../../tests/helpers.js';
import AuthService from '../../auth/auth.service.js';
import config from '../../../config/index.js';
import Deployment from '../../deployment/deployment.model.js';
import DeploymentService from '../../deployment/deployment.service.js';
import OrchestrationIntegration from '../orchestrationIntegration.model.js';
import OrchestrationObservation from '../orchestrationObservation.model.js';
import OrchestrationDelivery from '../orchestrationDelivery.model.js';
import SecurityScan from '../../security/securityScan.model.js';
import PolicyGateResult from '../../security/policyGateResult.model.js';
import GovernancePolicy from '../../security/governancePolicy.model.js';
import Issue from '../../issues/issue.model.js';
import Commit from '../../vcs/commit.model.js';
import Repository from '../../vcs/repository.model.js';
import ProjectMember from '../../projects/projectMember.model.js';
import {
  getOrchestrationProvider,
  _resetOrchestrationProviderRegistry,
} from '../providers/orchestrationProviderRegistry.js';
import {
  getOrchestrationQueue,
  enqueueOrchestrationJob,
  closeOrchestrationQueue,
  _resetOrchestrationQueue,
} from '../orchestrationQueue.js';
import { processOrchestrationJob } from '../orchestrationWorker.js';
import {
  DEPLOYMENT_PROVIDER,
  DEPLOYMENT_STATUS,
  DEPLOYMENT_GOVERNANCE_STATE,
  DEPLOYMENT_ENVIRONMENT,
  DEPLOYMENT_EVENTS,
  ORCHESTRATION_PROVIDER,
  ORCHESTRATION_HEALTH_STATUS,
  ORCHESTRATION_SYNC_STATUS,
  SECURITY_PROVIDER,
  SECURITY_SCAN_STATUS,
  POLICY_EVALUATION_STATE,
  POLICY_RULE_TYPE,
  POLICY_ENFORCEMENT,
} from '../../../shared/constants.js';
import { encrypt } from '../../../shared/crypto.js';
import eventBus from '../../notifications/eventBus.js';
import { createRedisConnection } from '../../../config/redis.js';

describe('Phase 4 Step 5 — Deployment State & Governance Integration', () => {
  let user;
  let devUser;
  let devAuthCookie;
  let project;
  let argoIntegration;
  let k8sIntegration;
  const rawSecret = 'secret-token-abcdef1234567890';

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
      createdBy: user._id,
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
      overriddenBy: isOverridden ? user._id : null,
      overriddenAt: isOverridden ? new Date() : null,
      overrideJustification: isOverridden ? 'Approved exception' : '',
    });
  }

  beforeEach(async () => {
    jest.restoreAllMocks();
    _resetOrchestrationProviderRegistry();
    _resetOrchestrationQueue(undefined);

    await Deployment.deleteMany({});
    await OrchestrationObservation.deleteMany({});
    await OrchestrationDelivery.deleteMany({});
    await OrchestrationIntegration.deleteMany({});
    await SecurityScan.deleteMany({});
    await PolicyGateResult.deleteMany({});
    await GovernancePolicy.deleteMany({});
    await Commit.deleteMany({});
    await Issue.deleteMany({});
    await Repository.deleteMany({});
    await ProjectMember.deleteMany({});

    const userData = await createTestUser({ role: 'admin' });
    user = userData.user;

    const devData = await createTestUser({ role: 'developer' });
    devUser = devData.user;
    const devToken = AuthService.generateToken(devUser);
    devAuthCookie = [`${config.jwt.cookieName}=${devToken}; Path=/; HttpOnly`];

    project = await createTestProject(user._id, {
      name: 'Deployment Orchestration Project',
      key: 'DOP',
    });

    await ProjectMember.create({
      project: project._id,
      user: devUser._id,
      role: 'developer',
    });

    const enc = encrypt(rawSecret);
    argoIntegration = await OrchestrationIntegration.create({
      project: project._id,
      name: 'Production ArgoCD',
      provider: ORCHESTRATION_PROVIDER.ARGOCD,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      serverUrl: 'https://argocd.production.internal',
      applicationName: 'order-service',
      encryptedToken: enc.ciphertext,
      tokenIv: enc.iv,
      tokenAuthTag: enc.authTag,
      tokenHint: '...7890',
      createdBy: user._id,
    });

    k8sIntegration = await OrchestrationIntegration.create({
      project: project._id,
      name: 'Production Kubernetes',
      provider: ORCHESTRATION_PROVIDER.KUBERNETES,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      serverUrl: 'https://k8s.production.internal:6443',
      namespace: 'production',
      encryptedToken: enc.ciphertext,
      tokenIv: enc.iv,
      tokenAuthTag: enc.authTag,
      tokenHint: '...7890',
      createdBy: user._id,
    });
  });

  afterAll(async () => {
    await closeOrchestrationQueue();
  });

  // =========================================================================
  // 1. Observation -> Deployment Projection & Idempotency
  // =========================================================================
  describe('1. Observation -> Deployment Projection & Idempotency', () => {
    it('creates an authoritative Deployment record from a new OrchestrationObservation', async () => {
      const observation = await OrchestrationObservation.create({
        integration: argoIntegration._id,
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: 'argocd:application:default:order-service',
        workload: { name: 'order-service', kind: 'Application', namespace: 'default' },
        health: {
          status: ORCHESTRATION_HEALTH_STATUS.HEALTHY,
          message: 'App is synced and healthy',
        },
        sync: {
          status: ORCHESTRATION_SYNC_STATUS.SYNCED,
          revision: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        },
        drift: { hasDrift: false, reasons: [] },
        runtime: { desiredReplicas: 3, readyReplicas: 3, availableReplicas: 3 },
      });

      const result = await DeploymentService.ingestOrchestrationObservation(observation);

      expect(result.isNew).toBe(true);
      expect(result.changed).toBe(true);
      expect(result.deployment).toBeDefined();

      const dep = await Deployment.findById(result.deployment._id);
      expect(dep).toBeDefined();
      expect(dep.project.toString()).toBe(project._id.toString());
      expect(dep.provider).toBe(DEPLOYMENT_PROVIDER.ARGOCD);
      expect(dep.environment).toBe(DEPLOYMENT_ENVIRONMENT.PRODUCTION);
      expect(dep.externalDeploymentId).toBe('argocd:application:default:order-service');
      expect(dep.status).toBe(DEPLOYMENT_STATUS.SUCCESS);
      expect(dep.commitSha).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
      expect(dep.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.NOT_EVALUATED);
      expect(dep.isGovernanceViolation).toBe(false);
      expect(dep.metadata.drift.hasDrift).toBe(false);
      expect(dep.metadata.orchestration.healthStatus).toBe(ORCHESTRATION_HEALTH_STATUS.HEALTHY);
      expect(dep.orchestrationObservation.toString()).toBe(observation._id.toString());
    });

    it('handles repeated identical observations idempotently without duplicate records or events', async () => {
      const observation = await OrchestrationObservation.create({
        integration: argoIntegration._id,
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: 'argocd:application:default:order-service',
        workload: { name: 'order-service', kind: 'Application', namespace: 'default' },
        health: { status: ORCHESTRATION_HEALTH_STATUS.HEALTHY, message: 'All pods healthy' },
        sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: 'commit-sha-1234' },
        drift: { hasDrift: false, reasons: [] },
      });

      const receivedEvents = [];
      const onEvent = (payload) => receivedEvents.push(payload);
      eventBus.on(DEPLOYMENT_EVENTS.COMPLETED, onEvent);

      try {
        // First ingestion
        const first = await DeploymentService.ingestOrchestrationObservation(observation);
        expect(first.isNew).toBe(true);
        expect(first.changed).toBe(true);
        expect(receivedEvents.length).toBe(1);

        receivedEvents.length = 0;

        // Repeated ingestion of the exact same observation
        const second = await DeploymentService.ingestOrchestrationObservation(observation);
        expect(second.isNew).toBe(false);
        expect(second.changed).toBe(false);
        expect(second.deployment._id.toString()).toBe(first.deployment._id.toString());

        // Crucial: Duplicate real-time event was suppressed
        expect(receivedEvents.length).toBe(0);

        // Ensure no duplicate records in database
        const totalDeployments = await Deployment.countDocuments({
          project: project._id,
          externalDeploymentId: 'argocd:application:default:order-service',
        });
        expect(totalDeployments).toBe(1);
      } finally {
        eventBus.off(DEPLOYMENT_EVENTS.COMPLETED, onEvent);
      }
    });

    it('updates existing deployment record when observation state changes', async () => {
      const observation = await OrchestrationObservation.create({
        integration: k8sIntegration._id,
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.KUBERNETES,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: 'kubernetes:deployment:production:order-api',
        workload: { name: 'order-api', kind: 'Deployment', namespace: 'production' },
        health: {
          status: ORCHESTRATION_HEALTH_STATUS.PROGRESSING,
          message: 'Rolling update in progress',
        },
        sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: 'sha-v1' },
        drift: { hasDrift: false, reasons: [] },
      });

      const first = await DeploymentService.ingestOrchestrationObservation(observation);
      expect(first.deployment.status).toBe(DEPLOYMENT_STATUS.IN_PROGRESS);

      // Now workload finishes rollout and becomes healthy with new revision
      observation.health.status = ORCHESTRATION_HEALTH_STATUS.HEALTHY;
      observation.sync.revision = 'sha-v2';
      await observation.save();

      const updated = await DeploymentService.ingestOrchestrationObservation(observation);
      expect(updated.isNew).toBe(false);
      expect(updated.changed).toBe(true);
      expect(updated.deployment.status).toBe(DEPLOYMENT_STATUS.SUCCESS);
      expect(updated.deployment.commitSha).toBe('sha-v2');

      const totalDeployments = await Deployment.countDocuments({
        project: project._id,
        externalDeploymentId: 'kubernetes:deployment:production:order-api',
      });
      expect(totalDeployments).toBe(1);
    });
  });

  // =========================================================================
  // 2. Status Normalization Mapping
  // =========================================================================
  describe('2. Status Normalization Mapping', () => {
    async function testStatusMapping({ healthStatus, operationPhase, expectedDeploymentStatus }) {
      const uniqueId = `workload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const obs = {
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.KUBERNETES,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: `kubernetes:deployment:default:${uniqueId}`,
        workload: { name: uniqueId, kind: 'Deployment', namespace: 'default' },
        health: { status: healthStatus, message: `Status is ${healthStatus}` },
        sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: 'sha-test' },
        drift: { hasDrift: false, reasons: [] },
        runtime: { operationPhase },
      };

      const result = await DeploymentService.ingestOrchestrationObservation(obs);
      expect(result.deployment.status).toBe(expectedDeploymentStatus);
    }

    it('maps healthy to success', async () => {
      await testStatusMapping({
        healthStatus: ORCHESTRATION_HEALTH_STATUS.HEALTHY,
        expectedDeploymentStatus: DEPLOYMENT_STATUS.SUCCESS,
      });
    });

    it('maps progressing to in_progress', async () => {
      await testStatusMapping({
        healthStatus: ORCHESTRATION_HEALTH_STATUS.PROGRESSING,
        expectedDeploymentStatus: DEPLOYMENT_STATUS.IN_PROGRESS,
      });
    });

    it('maps runtime operationPhase Running to in_progress', async () => {
      await testStatusMapping({
        healthStatus: ORCHESTRATION_HEALTH_STATUS.UNKNOWN,
        operationPhase: 'Running',
        expectedDeploymentStatus: DEPLOYMENT_STATUS.IN_PROGRESS,
      });
    });

    it('maps degraded to failure', async () => {
      await testStatusMapping({
        healthStatus: ORCHESTRATION_HEALTH_STATUS.DEGRADED,
        expectedDeploymentStatus: DEPLOYMENT_STATUS.FAILED,
      });
    });

    it('maps operationPhase Failed to failure', async () => {
      await testStatusMapping({
        healthStatus: ORCHESTRATION_HEALTH_STATUS.HEALTHY,
        operationPhase: 'Failed',
        expectedDeploymentStatus: DEPLOYMENT_STATUS.FAILED,
      });
    });

    it('maps missing to failure', async () => {
      await testStatusMapping({
        healthStatus: ORCHESTRATION_HEALTH_STATUS.MISSING,
        expectedDeploymentStatus: DEPLOYMENT_STATUS.FAILED,
      });
    });

    it('maps suspended to cancelled', async () => {
      await testStatusMapping({
        healthStatus: ORCHESTRATION_HEALTH_STATUS.SUSPENDED,
        expectedDeploymentStatus: DEPLOYMENT_STATUS.CANCELLED,
      });
    });

    it('maps operationPhase Initiated to queued', async () => {
      await testStatusMapping({
        healthStatus: ORCHESTRATION_HEALTH_STATUS.UNKNOWN,
        operationPhase: 'Initiated',
        expectedDeploymentStatus: DEPLOYMENT_STATUS.QUEUED,
      });
    });

    it('maps unknown health and phase to unknown', async () => {
      await testStatusMapping({
        healthStatus: ORCHESTRATION_HEALTH_STATUS.UNKNOWN,
        expectedDeploymentStatus: DEPLOYMENT_STATUS.UNKNOWN,
      });
    });
  });

  // =========================================================================
  // 3. Phase 3 Governance Engine Integration
  // =========================================================================
  describe('3. Phase 3 Governance Engine Integration', () => {
    const testCommitSha = 'c0ffee1234567890c0ffee1234567890c0ffee12';

    it('evaluates ALLOWED when security policy passed for commitSha', async () => {
      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha: testCommitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-1',
        findingsSummary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
        gateStatus: POLICY_EVALUATION_STATE.PASS,
      });

      await createPolicyAndGate({ scan, passed: true });

      const observation = {
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: 'argocd:application:default:allowed-service',
        workload: { name: 'allowed-service', kind: 'Application', namespace: 'default' },
        health: { status: ORCHESTRATION_HEALTH_STATUS.HEALTHY },
        sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: testCommitSha },
        drift: { hasDrift: false, reasons: [] },
      };

      const result = await DeploymentService.ingestOrchestrationObservation(observation);
      expect(result.deployment.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.ALLOWED);
      expect(result.deployment.isGovernanceViolation).toBe(false);
    });

    it('evaluates BLOCKED and flags isGovernanceViolation=true when external deployment succeeds despite failing policy', async () => {
      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha: testCommitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-2',
        findingsSummary: { critical: 2, high: 5, medium: 0, low: 0, total: 7 },
        gateStatus: POLICY_EVALUATION_STATE.FAIL,
      });

      await createPolicyAndGate({ scan, passed: false, isOverridden: false });

      const observation = {
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: 'argocd:application:default:blocked-service',
        workload: { name: 'blocked-service', kind: 'Application', namespace: 'default' },
        health: { status: ORCHESTRATION_HEALTH_STATUS.HEALTHY }, // Succeeded externally
        sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: testCommitSha },
        drift: { hasDrift: false, reasons: [] },
      };

      const result = await DeploymentService.ingestOrchestrationObservation(observation);
      expect(result.deployment.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.BLOCKED);
      expect(result.deployment.isGovernanceViolation).toBe(true);
    });

    it('evaluates BLOCKED and sets isGovernanceViolation=false when external deployment is degraded', async () => {
      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha: testCommitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-3',
        findingsSummary: { critical: 1, high: 0, medium: 0, low: 0, total: 1 },
        gateStatus: POLICY_EVALUATION_STATE.FAIL,
      });

      await createPolicyAndGate({ scan, passed: false });

      const observation = {
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.KUBERNETES,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: 'kubernetes:deployment:default:failing-workload',
        workload: { name: 'failing-workload', kind: 'Deployment', namespace: 'default' },
        health: { status: ORCHESTRATION_HEALTH_STATUS.DEGRADED }, // Failed externally
        sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: testCommitSha },
        drift: { hasDrift: false, reasons: [] },
      };

      const result = await DeploymentService.ingestOrchestrationObservation(observation);
      expect(result.deployment.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.BLOCKED);
      expect(result.deployment.status).toBe(DEPLOYMENT_STATUS.FAILED);
      expect(result.deployment.isGovernanceViolation).toBe(false);
    });

    it('evaluates OVERRIDDEN when gate was overridden by Security Admin', async () => {
      const scan = await SecurityScan.create({
        project: project._id,
        provider: SECURITY_PROVIDER.TRIVY,
        status: SECURITY_SCAN_STATUS.COMPLETED,
        commitSha: testCommitSha,
        target: 'fs:.',
        reportDigest: 'sha256-test-digest-4',
        findingsSummary: { critical: 1, high: 0, medium: 0, low: 0, total: 1 },
        gateStatus: POLICY_EVALUATION_STATE.FAIL,
      });

      await createPolicyAndGate({ scan, passed: false, isOverridden: true });

      const observation = {
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: 'argocd:application:default:overridden-service',
        workload: { name: 'overridden-service', kind: 'Application', namespace: 'default' },
        health: { status: ORCHESTRATION_HEALTH_STATUS.HEALTHY },
        sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: testCommitSha },
        drift: { hasDrift: false, reasons: [] },
      };

      const result = await DeploymentService.ingestOrchestrationObservation(observation);
      expect(result.deployment.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.OVERRIDDEN);
      expect(result.deployment.isGovernanceViolation).toBe(false);
    });

    it('evaluates NOT_EVALUATED when no security scan exists for commitSha', async () => {
      const observation = {
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: 'argocd:application:default:unscanned-service',
        workload: { name: 'unscanned-service', kind: 'Application', namespace: 'default' },
        health: { status: ORCHESTRATION_HEALTH_STATUS.HEALTHY },
        sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: 'unscanned-sha-000000' },
        drift: { hasDrift: false, reasons: [] },
      };

      const result = await DeploymentService.ingestOrchestrationObservation(observation);
      expect(result.deployment.governanceDecision).toBe(DEPLOYMENT_GOVERNANCE_STATE.NOT_EVALUATED);
      expect(result.deployment.isGovernanceViolation).toBe(false);
    });
  });

  // =========================================================================
  // 4. Drift-Aware Governance & Delivery State
  // =========================================================================
  describe('4. Drift-Aware Governance & Delivery State Integration', () => {
    it('captures normalized drift details and provides them in delivery state', async () => {
      const linkedSha = 'a9876543210fedcba9876543210fedcba9876543';

      const issue = await Issue.create({
        project: project._id,
        issueNumber: 42,
        issueKey: 'DOP-42',
        title: 'Cloud native order checkout',
        type: 'feature',
        status: 'in_progress',
        reporter: user._id,
        createdBy: user._id,
      });

      const repo = await Repository.create({
        project: project._id,
        name: 'order-service',
        owner: 'testowner',
        fullName: 'testowner/order-service',
        externalId: '12345678',
        htmlUrl: 'https://github.com/testowner/order-service',
        connectedBy: user._id,
        encryptedToken: 'cipher',
        tokenIv: 'iv',
        tokenAuthTag: 'tag',
      });

      await Commit.create({
        project: project._id,
        repository: repo._id,
        sha: linkedSha,
        message: 'feat(order): DOP-42 cloud native deployment',
        matchedIssueKeys: ['DOP-42'],
        authoredAt: new Date(),
      });

      const observation = await OrchestrationObservation.create({
        integration: argoIntegration._id,
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: 'argocd:application:default:order-drift-service',
        workload: { name: 'order-drift-service', kind: 'Application', namespace: 'default' },
        health: {
          status: ORCHESTRATION_HEALTH_STATUS.HEALTHY,
          message: 'Healthy with live configuration drift',
        },
        sync: { status: ORCHESTRATION_SYNC_STATUS.OUT_OF_SYNC, revision: linkedSha },
        drift: {
          hasDrift: true,
          reasons: [
            'Replica count mismatch: expected 3, found 5',
            'Live image modified out-of-band',
          ],
        },
        runtime: { desiredReplicas: 3, readyReplicas: 5, availableReplicas: 5 },
      });

      await DeploymentService.ingestOrchestrationObservation(observation);

      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/${issue.issueKey}/delivery-state`)
        .set('Cookie', devAuthCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const deliveryState = res.body.data;
      expect(deliveryState.stages.deployment).toBeDefined();
      expect(deliveryState.stages.deployment.status).toBe('completed');
      expect(deliveryState.stages.deployment.hasDrift).toBe(true);
      expect(deliveryState.stages.deployment.drift.reasons).toEqual(
        expect.arrayContaining(['Replica count mismatch: expected 3, found 5'])
      );
      expect(deliveryState.stages.deployment.healthStatus).toBe(
        ORCHESTRATION_HEALTH_STATUS.HEALTHY
      );
      expect(deliveryState.stages.deployment.syncStatus).toBe(
        ORCHESTRATION_SYNC_STATUS.OUT_OF_SYNC
      );
      expect(deliveryState.stages.deployment.latestDeployment.provider).toBe(
        DEPLOYMENT_PROVIDER.ARGOCD
      );
      expect(deliveryState.traceability.associatedDeploymentId).toBeDefined();
    });

    it('does not fabricate issue linkage when observation revision does not match issue commits', async () => {
      const issue = await Issue.create({
        project: project._id,
        issueNumber: 99,
        issueKey: 'DOP-99',
        title: 'Unrelated issue',
        type: 'feature',
        status: 'open',
        reporter: user._id,
        createdBy: user._id,
      });

      const observation = await OrchestrationObservation.create({
        integration: k8sIntegration._id,
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.KUBERNETES,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: 'kubernetes:deployment:production:unrelated-workload',
        workload: { name: 'unrelated-workload', kind: 'Deployment', namespace: 'production' },
        health: { status: ORCHESTRATION_HEALTH_STATUS.HEALTHY },
        sync: {
          status: ORCHESTRATION_SYNC_STATUS.SYNCED,
          revision: 'different-sha-000000000000000000000000000000',
        },
        drift: { hasDrift: false, reasons: [] },
      });

      await DeploymentService.ingestOrchestrationObservation(observation);

      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/${issue.issueKey}/delivery-state`)
        .set('Cookie', devAuthCookie);

      expect(res.status).toBe(200);
      expect(res.body.data.stages.deployment.status).toBe('pending');
      expect(res.body.data.stages.deployment.latestDeployment).toBeNull();
      expect(res.body.data.traceability.associatedDeploymentId).toBeNull();
    });
  });

  // =========================================================================
  // 5. Realtime Events & Payload Sanitization
  // =========================================================================
  describe('5. Realtime Domain Events & Payload Sanitization', () => {
    it('persists state in MongoDB before publishing realtime event', async () => {
      const observation = {
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        workloadIdentifier: 'argocd:application:default:payment-events-app',
        workload: { name: 'payment-events-app', kind: 'Application', namespace: 'default' },
        health: { status: ORCHESTRATION_HEALTH_STATUS.HEALTHY },
        sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: 'sha-evt-123' },
        drift: { hasDrift: false, reasons: [] },
      };

      let persistedBeforeEvent = false;
      const onEvent = async (payload) => {
        const found = await Deployment.findById(payload.deploymentId);
        if (found) {
          persistedBeforeEvent = true;
        }
      };

      eventBus.on(DEPLOYMENT_EVENTS.COMPLETED, onEvent);

      try {
        await DeploymentService.ingestOrchestrationObservation(observation);
        expect(persistedBeforeEvent).toBe(true);
      } finally {
        eventBus.off(DEPLOYMENT_EVENTS.COMPLETED, onEvent);
      }
    });

    it('ensures event payload contains safe fields and never contains credentials or secrets', async () => {
      let publishedPayload = null;
      const onEvent = (payload) => {
        publishedPayload = payload;
      };

      eventBus.on(DEPLOYMENT_EVENTS.COMPLETED, onEvent);

      try {
        const observation = {
          project: project._id,
          provider: ORCHESTRATION_PROVIDER.KUBERNETES,
          environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
          workloadIdentifier: 'kubernetes:deployment:production:secure-workload',
          workload: { name: 'secure-workload', kind: 'Deployment', namespace: 'production' },
          health: { status: ORCHESTRATION_HEALTH_STATUS.HEALTHY },
          sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: 'sha-secure' },
          drift: { hasDrift: false, reasons: [] },
        };

        await DeploymentService.ingestOrchestrationObservation(observation);

        expect(publishedPayload).toBeDefined();
        expect(publishedPayload.projectId).toBe(String(project._id));
        expect(publishedPayload.status).toBe(DEPLOYMENT_STATUS.SUCCESS);
        expect(publishedPayload.provider).toBe(DEPLOYMENT_PROVIDER.KUBERNETES);

        // Verify no secret leak
        const stringified = JSON.stringify(publishedPayload);
        expect(stringified).not.toContain(rawSecret);
        expect(stringified).not.toContain('encryptedToken');
        expect(stringified).not.toContain('tokenIv');
        expect(stringified).not.toContain('tokenAuthTag');
      } finally {
        eventBus.off(DEPLOYMENT_EVENTS.COMPLETED, onEvent);
      }
    });
  });

  // =========================================================================
  // 6. BullMQ Worker Processing Integration
  // =========================================================================
  describe('6. BullMQ Worker Processing Integration', () => {
    it('creates both OrchestrationObservation AND Deployment when job is processed by worker', async () => {
      const mockProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.ARGOCD);
      const fetchSpy = jest.spyOn(mockProvider, 'fetchWorkloadStatus').mockResolvedValue({
        applicationName: 'order-service',
        healthStatus: 'healthy',
        healthMessage: 'All systems nominal',
        syncStatus: 'synced',
        currentRevision: 'sha-worker-integration-1234',
        desiredReplicas: 3,
        readyReplicas: 3,
        availableReplicas: 3,
      });

      const delivery = await OrchestrationDelivery.create({
        integration: argoIntegration._id,
        project: project._id,
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        deliveryKey: 'del-worker-test-1',
        payloadDigest: 'sha256-payload-digest-test',
        event: 'application_updated',
        status: 'queued',
      });

      const jobData = {
        integrationId: argoIntegration._id.toString(),
        deliveryId: delivery._id.toString(),
        applicationName: 'order-service',
        reason: 'webhook_reconciliation',
      };

      const outcome = await processOrchestrationJob(jobData);

      expect(outcome.success).toBe(true);
      expect(outcome.observationId).toBeDefined();
      expect(outcome.deploymentId).toBeDefined();
      expect(outcome.isNewDeployment).toBe(true);
      expect(outcome.deploymentChanged).toBe(true);

      // Verify OrchestrationObservation was persisted
      const observation = await OrchestrationObservation.findById(outcome.observationId);
      expect(observation).toBeDefined();
      expect(observation.health.status).toBe('healthy');

      // Verify Deployment projection was persisted
      const deployment = await Deployment.findById(outcome.deploymentId);
      expect(deployment).toBeDefined();
      expect(deployment.provider).toBe(DEPLOYMENT_PROVIDER.ARGOCD);
      expect(deployment.status).toBe(DEPLOYMENT_STATUS.SUCCESS);
      expect(deployment.commitSha).toBe('sha-worker-integration-1234');
      expect(deployment.externalDeploymentId).toBe('argocd:application:default:order-service');

      fetchSpy.mockRestore();
    });
  });

  // =========================================================================
  // 7. Live Redis / BullMQ Integration Path
  // =========================================================================
  describe('7. Real Redis / BullMQ Integration Path', () => {
    it('successfully enqueues into real BullMQ queue and verifies job in backlog', async () => {
      const client = createRedisConnection();
      let redisOnline = false;
      try {
        const pingRes = await client.ping();
        redisOnline = pingRes === 'PONG';
      } catch {
        redisOnline = false;
      } finally {
        await client.quit().catch(() => {});
      }

      if (!redisOnline) {
        console.warn('Real Redis not reachable; skipping live Redis queue test');
        return;
      }

      const queue = getOrchestrationQueue();
      const res = await enqueueOrchestrationJob({
        integrationId: argoIntegration._id.toString(),
        projectId: project._id.toString(),
        reason: 'step5_live_redis_test',
        applicationName: 'order-service',
      });

      expect(res.enqueued).toBe(true);
      expect(res.jobId).toBeDefined();

      const retrieved = await queue.getJob(res.jobId);
      expect(retrieved).toBeDefined();
      expect(retrieved.id).toBe(res.jobId);
      expect(retrieved.data.integrationId).toBe(argoIntegration._id.toString());

      // Clean up test job
      await retrieved.remove().catch(() => {});
    });
  });
});

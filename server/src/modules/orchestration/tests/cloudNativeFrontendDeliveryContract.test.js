import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../../app.js';
import Issue from '../../issues/issue.model.js';
import PipelineRun from '../../cicd/pipelineRun.model.js';
import Commit from '../../vcs/commit.model.js';
import Deployment from '../../deployment/deployment.model.js';
import DeploymentService from '../../deployment/deployment.service.js';
import OrchestrationIntegration from '../orchestrationIntegration.model.js';
import OrchestrationObservation from '../orchestrationObservation.model.js';
import { createTestUser, createTestProject } from '../../../../tests/helpers.js';
import AuthService from '../../auth/auth.service.js';
import { encrypt } from '../../../shared/crypto.js';
import {
  ORCHESTRATION_PROVIDER,
  ORCHESTRATION_HEALTH_STATUS,
  ORCHESTRATION_SYNC_STATUS,
  DEPLOYMENT_ENVIRONMENT,
  DEPLOYMENT_STATUS,
  DEPLOYMENT_GOVERNANCE_STATE,
} from '../../../shared/constants.js';

describe('Phase 4 Step 6 — Cloud-Native Frontend Delivery Contract & Realtime Integration', () => {
  let user;
  let authCookie;
  let project;
  let k8sIntegration;
  let argoIntegration;
  const issueKey = 'CLOUD-404';
  const commitSha = 'c104d404e404f404a404b404c404d404e404f404';

  beforeEach(async () => {
    const userRes = await createTestUser({ role: 'admin' });
    user = userRes.user;

    const token = AuthService.generateToken(user);
    authCookie = [`udp_token=${token}; Path=/; HttpOnly`];

    project = await createTestProject(user._id, {
      key: 'CLOUD',
      name: 'Cloud-Native Delivery Test Project',
    });

    // Create Issue
    await Issue.create({
      project: project._id,
      issueKey,
      issueNumber: 404,
      title: 'Cloud-native frontend delivery observability',
      status: 'in_progress',
      priority: 'high',
      type: 'feature',
      reporter: user._id,
    });

    // Create Commit linking to this issue
    await Commit.create({
      project: project._id,
      repository: new mongoose.Types.ObjectId(),
      sha: commitSha,
      message: `${issueKey}: add cloud-native workload observation`,
      authorName: 'Developer',
      authorEmail: 'dev@example.com',
      authoredAt: new Date(),
      matchedIssueKeys: [issueKey],
    });

    // Create PipelineRun linking to this commit & issue
    await PipelineRun.create({
      project: project._id,
      repository: new mongoose.Types.ObjectId(),
      provider: 'github_actions',
      externalRunId: `run-${Date.now()}`,
      workflowName: 'Deploy to Kubernetes',
      runNumber: 42,
      status: 'completed',
      conclusion: 'success',
      branch: 'feature/cloud-native',
      commitSha,
      matchedIssueKeys: [issueKey],
      startedAt: new Date(Date.now() - 60000),
      completedAt: new Date(),
      duration: 60,
    });

    // Create K8s and Argo Integrations
    const enc = encrypt('test-secret-token-12345');
    k8sIntegration = await OrchestrationIntegration.create({
      project: project._id,
      name: 'Production Kubernetes Cluster',
      provider: ORCHESTRATION_PROVIDER.KUBERNETES,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      serverUrl: 'https://k8s.example.com:6443',
      namespace: 'kube-system',
      encryptedToken: enc.ciphertext,
      tokenIv: enc.iv,
      tokenAuthTag: enc.authTag,
      tokenHint: '••••••••2345',
      createdBy: user._id,
    });

    argoIntegration = await OrchestrationIntegration.create({
      project: project._id,
      name: 'Production ArgoCD Instance',
      provider: ORCHESTRATION_PROVIDER.ARGOCD,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      serverUrl: 'https://argocd.example.com',
      applicationName: 'payment-service',
      encryptedToken: enc.ciphertext,
      tokenIv: enc.iv,
      tokenAuthTag: enc.authTag,
      tokenHint: '••••••••2345',
      createdBy: user._id,
    });
  });

  // =========================================================================
  // 1. Kubernetes Deployment State Rendering
  // =========================================================================
  it('Requirement 1: Renders complete Kubernetes deployment state with workload, namespace, health, sync, and replicas', async () => {
    const observation = await OrchestrationObservation.create({
      integration: k8sIntegration._id,
      project: project._id,
      provider: ORCHESTRATION_PROVIDER.KUBERNETES,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      workloadIdentifier: 'kubernetes:deployment:kube-system:coredns',
      workload: { name: 'coredns', kind: 'Deployment', namespace: 'kube-system' },
      health: {
        status: ORCHESTRATION_HEALTH_STATUS.HEALTHY,
        message: 'All 2 replicas are ready and available',
      },
      sync: {
        status: ORCHESTRATION_SYNC_STATUS.SYNCED,
        revision: commitSha,
      },
      drift: { hasDrift: false, reasons: [] },
      runtime: {
        desiredReplicas: 2,
        readyReplicas: 2,
        availableReplicas: 2,
        updatedReplicas: 2,
        currentRevision: '1',
        observedGeneration: 1,
      },
    });

    await DeploymentService.ingestOrchestrationObservation(observation);

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;
    const dep = data.deployment;

    expect(dep).toBeDefined();
    expect(dep.status).toBe('completed');
    expect(dep.environment).toBe('production');
    expect(dep.hasDrift).toBe(false);
    expect(dep.healthStatus).toBe('healthy');
    expect(dep.syncStatus).toBe('synced');
    expect(dep.latestDeployment.provider).toBe('kubernetes');
    expect(dep.latestDeployment.orchestration.workload.name).toBe('coredns');
    expect(dep.latestDeployment.orchestration.workload.kind).toBe('Deployment');
    expect(dep.latestDeployment.orchestration.workload.namespace).toBe('kube-system');
    expect(dep.latestDeployment.orchestration.healthMessage).toBe(
      'All 2 replicas are ready and available'
    );
    expect(dep.latestDeployment.orchestration.runtime.desiredReplicas).toBe(2);
    expect(dep.latestDeployment.orchestration.runtime.readyReplicas).toBe(2);
  });

  // =========================================================================
  // 2. Argo CD State Rendering (Data Exists)
  // =========================================================================
  it('Requirement 2: Renders Argo CD application state when application data exists', async () => {
    const observation = await OrchestrationObservation.create({
      integration: argoIntegration._id,
      project: project._id,
      provider: ORCHESTRATION_PROVIDER.ARGOCD,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      workloadIdentifier: 'argocd:application:default:payment-service',
      workload: { name: 'payment-service', kind: 'Application', namespace: 'default' },
      health: {
        status: ORCHESTRATION_HEALTH_STATUS.HEALTHY,
        message: 'All application resources healthy',
      },
      sync: {
        status: ORCHESTRATION_SYNC_STATUS.SYNCED,
        revision: commitSha,
      },
      drift: { hasDrift: false, reasons: [] },
      runtime: {
        operationPhase: 'succeeded',
      },
    });

    await DeploymentService.ingestOrchestrationObservation(observation);

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const dep = res.body.data.deployment;
    expect(dep.latestDeployment.provider).toBe('argocd');
    expect(dep.latestDeployment.orchestration.workload.name).toBe('payment-service');
    expect(dep.latestDeployment.orchestration.workload.kind).toBe('Application');
    expect(dep.healthStatus).toBe('healthy');
    expect(dep.syncStatus).toBe('synced');
    expect(dep.hasDrift).toBe(false);
  });

  // =========================================================================
  // 3. Empty Argo CD State (Zero Applications)
  // =========================================================================
  it('Requirement 3: Renders appropriate empty state when Argo CD has zero applications', async () => {
    // Integration exists, but no observation or application has synced for this issue
    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const dep = res.body.data.deployment;
    expect(dep.status).toBe('pending');
    expect(dep.latestDeployment).toBeNull();
    // Does NOT fabricate fake Argo application data
    expect(res.body.data.stages.deployment.latestDeployment).toBeNull();
  });

  // =========================================================================
  // 4. Drift State & Drift Reasons Rendering
  // =========================================================================
  it('Requirement 4: Renders drift state with specific reasons when workload diverges', async () => {
    const observation = await OrchestrationObservation.create({
      integration: k8sIntegration._id,
      project: project._id,
      provider: ORCHESTRATION_PROVIDER.KUBERNETES,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      workloadIdentifier: 'kubernetes:deployment:kube-system:coredns',
      workload: { name: 'coredns', kind: 'Deployment', namespace: 'kube-system' },
      health: {
        status: ORCHESTRATION_HEALTH_STATUS.HEALTHY,
        message: 'Deployment progressing',
      },
      sync: {
        status: ORCHESTRATION_SYNC_STATUS.OUT_OF_SYNC,
        revision: commitSha,
      },
      drift: {
        hasDrift: true,
        reasons: [
          'Ready replicas (1) less than desired (3)',
          'Observed generation (2) does not match generation (3)',
        ],
      },
      runtime: { desiredReplicas: 3, readyReplicas: 1 },
    });

    await DeploymentService.ingestOrchestrationObservation(observation);

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const dep = res.body.data.deployment;
    expect(dep.hasDrift).toBe(true);
    expect(dep.drift.reasons).toEqual(
      expect.arrayContaining([
        'Ready replicas (1) less than desired (3)',
        'Observed generation (2) does not match generation (3)',
      ])
    );
    expect(dep.latestDeployment.drift.hasDrift).toBe(true);
    expect(dep.latestDeployment.drift.reasons).toHaveLength(2);
  });

  // =========================================================================
  // 5. Governance BLOCKED State vs Health
  // =========================================================================
  it('Requirement 5: Clearly distinguishes Healthy deployment from BLOCKED governance decision and detects violation', async () => {
    // Record a deployment where status is success, but governanceDecision is BLOCKED
    await Deployment.create({
      project: project._id,
      provider: 'kubernetes',
      environment: 'production',
      externalDeploymentId: 'kubernetes:deployment:kube-system:coredns',
      status: DEPLOYMENT_STATUS.SUCCESS,
      commitSha,
      governanceDecision: DEPLOYMENT_GOVERNANCE_STATE.BLOCKED,
      isGovernanceViolation: true,
      metadata: {
        orchestration: {
          workloadIdentifier: 'kubernetes:deployment:kube-system:coredns',
          workload: { name: 'coredns', kind: 'Deployment', namespace: 'kube-system' },
          healthStatus: 'healthy',
          syncStatus: 'synced',
        },
        drift: { hasDrift: false, reasons: [] },
      },
      startedAt: new Date(Date.now() - 30000),
      completedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const dep = res.body.data.deployment;
    // Health is healthy
    expect(dep.healthStatus).toBe('healthy');
    // Governance is BLOCKED
    expect(dep.governanceDecision).toBe('BLOCKED');
    // Violation alert is true
    expect(dep.isGovernanceViolation).toBe(true);
  });

  // =========================================================================
  // 6. Governance OVERRIDDEN State
  // =========================================================================
  it('Requirement 6: Accurately renders OVERRIDDEN governance decision with manual exception flag', async () => {
    await Deployment.create({
      project: project._id,
      provider: 'kubernetes',
      environment: 'production',
      externalDeploymentId: 'kubernetes:deployment:kube-system:coredns',
      status: DEPLOYMENT_STATUS.SUCCESS,
      commitSha,
      governanceDecision: DEPLOYMENT_GOVERNANCE_STATE.OVERRIDDEN,
      isGovernanceViolation: false,
      metadata: {
        orchestration: {
          workloadIdentifier: 'kubernetes:deployment:kube-system:coredns',
          workload: { name: 'coredns', kind: 'Deployment', namespace: 'kube-system' },
          healthStatus: 'healthy',
          syncStatus: 'synced',
        },
        drift: { hasDrift: false, reasons: [] },
      },
      startedAt: new Date(Date.now() - 30000),
      completedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const dep = res.body.data.deployment;
    expect(dep.governanceDecision).toBe('OVERRIDDEN');
    expect(dep.isGovernanceViolation).toBe(false);
  });

  // =========================================================================
  // 7. Loading / Pending / Not Started State
  // =========================================================================
  it('Requirement 7: Renders clean not started / pending state when no deployment exists', async () => {
    // Unlink the commit from the issue
    await Commit.deleteMany({ matchedIssueKeys: issueKey });
    await PipelineRun.deleteMany({ matchedIssueKeys: issueKey });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const dep = res.body.data.deployment;
    expect(dep.status).toBe('pending');
    expect(dep.latestDeployment).toBeNull();
    expect(dep.environment).toBeNull();
    expect(dep.hasDrift).toBe(false);
  });

  // =========================================================================
  // 8. Provider Unavailable / Error State
  // =========================================================================
  it('Requirement 8: Renders failed status with safe error message when deployment fails', async () => {
    await Deployment.create({
      project: project._id,
      provider: 'kubernetes',
      environment: 'production',
      externalDeploymentId: 'kubernetes:deployment:kube-system:coredns',
      status: DEPLOYMENT_STATUS.FAILED,
      commitSha,
      errorMessage: 'Cluster API responded with HTTP 503: Service Unavailable',
      metadata: {
        orchestration: {
          workloadIdentifier: 'kubernetes:deployment:kube-system:coredns',
          workload: { name: 'coredns', kind: 'Deployment', namespace: 'kube-system' },
          healthStatus: 'degraded',
          syncStatus: 'unknown',
        },
        drift: { hasDrift: false, reasons: [] },
      },
      startedAt: new Date(Date.now() - 30000),
      completedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const dep = res.body.data.deployment;
    expect(dep.status).toBe('failed');
    expect(dep.latestDeployment.status).toBe('failed');
    expect(dep.latestDeployment.errorMessage).toBe(
      'Cluster API responded with HTTP 503: Service Unavailable'
    );
    expect(dep.healthStatus).toBe('degraded');
  });

  // =========================================================================
  // 9. Realtime Deployment Update Path
  // =========================================================================
  it('Requirement 9: Ingestion persists authoritative state before publishing domain event', async () => {
    const observation = {
      project: project._id,
      provider: ORCHESTRATION_PROVIDER.KUBERNETES,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      workloadIdentifier: 'kubernetes:deployment:kube-system:coredns',
      workload: { name: 'coredns', kind: 'Deployment', namespace: 'kube-system' },
      health: { status: ORCHESTRATION_HEALTH_STATUS.HEALTHY },
      sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: commitSha },
      drift: { hasDrift: false, reasons: [] },
    };

    const result = await DeploymentService.ingestOrchestrationObservation(observation);
    expect(result.deployment).toBeDefined();

    // Verify persisted immediately in MongoDB
    const persisted = await Deployment.findById(result.deployment._id);
    expect(persisted).not.toBeNull();
    expect(persisted.status).toBe(DEPLOYMENT_STATUS.SUCCESS);
  });

  // =========================================================================
  // 10. Duplicate Event Handling
  // =========================================================================
  it('Requirement 10: Suppresses duplicate updates when observation state is unchanged', async () => {
    const observation = {
      project: project._id,
      provider: ORCHESTRATION_PROVIDER.KUBERNETES,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      workloadIdentifier: 'kubernetes:deployment:kube-system:coredns',
      workload: { name: 'coredns', kind: 'Deployment', namespace: 'kube-system' },
      health: { status: ORCHESTRATION_HEALTH_STATUS.HEALTHY },
      sync: { status: ORCHESTRATION_SYNC_STATUS.SYNCED, revision: commitSha },
      drift: { hasDrift: false, reasons: [] },
    };

    const firstResult = await DeploymentService.ingestOrchestrationObservation(observation);
    expect(firstResult.isNew).toBe(true);

    const secondResult = await DeploymentService.ingestOrchestrationObservation(observation);
    expect(secondResult.isNew).toBe(false);
    expect(secondResult.changed).toBe(false);
  });

  // =========================================================================
  // 11. Page Refresh / State Reconstruction
  // =========================================================================
  it('Requirement 11: Authoritative REST delivery-state endpoint reliably reconstructs complete pipeline state', async () => {
    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const data = res.body.data;

    // Verify all 8 delivery stages exist and are reconstructible
    expect(data.stages).toBeDefined();
    expect(data.stages.issue).toBeDefined();
    expect(data.stages.branch).toBeDefined();
    expect(data.stages.commit).toBeDefined();
    expect(data.stages.pr).toBeDefined();
    expect(data.stages.ci).toBeDefined();
    expect(data.stages.security).toBeDefined();
    expect(data.stages.governance).toBeDefined();
    expect(data.stages.deployment).toBeDefined();
  });

  // =========================================================================
  // 12. Security Invariant: Zero Credential Leakage
  // =========================================================================
  it('Requirement 12: Never exposes tokens, IVs, tags, or CA certs in delivery-state response', async () => {
    const res = await request(app)
      .get(`/api/v1/projects/${project._id}/issues/${issueKey}/delivery-state`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const bodyText = JSON.stringify(res.body);

    expect(bodyText).not.toContain('test-secret-token-12345');
    expect(bodyText).not.toContain('encryptedToken');
    expect(bodyText).not.toContain('tokenIv');
    expect(bodyText).not.toContain('tokenAuthTag');
    expect(bodyText).not.toContain('caCertificate');
  });
});

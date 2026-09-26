import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../../app.js';
import { createTestUser, createTestProject } from '../../../../tests/helpers.js';
import OrchestrationIntegration from '../orchestrationIntegration.model.js';
import OrchestrationDelivery from '../orchestrationDelivery.model.js';
import OrchestrationObservation from '../orchestrationObservation.model.js';
import {
  getOrchestrationProvider,
  _resetOrchestrationProviderRegistry,
} from '../providers/orchestrationProviderRegistry.js';
import {
  getOrchestrationQueue,
  enqueueOrchestrationJob,
  scheduleRepeatableOrchestrationReconciliation,
  getOrchestrationQueueHealth,
  closeOrchestrationQueue,
  _resetOrchestrationQueue,
} from '../orchestrationQueue.js';
import {
  processOrchestrationJob,
  processScheduledReconciliation,
  isTransientError,
  sanitizeErrorMessage,
} from '../orchestrationWorker.js';
import {
  ORCHESTRATION_PROVIDER,
  ORCHESTRATION_STATUS,
  ORCHESTRATION_DELIVERY_STATUS,
  DEPLOYMENT_ENVIRONMENT,
} from '../../../shared/constants.js';
import { encrypt } from '../../../shared/crypto.js';
import { UnrecoverableError } from 'bullmq';

describe('Phase 4 Step 4 — Durable Orchestration Queue & Worker', () => {
  let user;
  let project;
  let argoIntegration;
  let k8sIntegration;
  const rawArgoSecret = 'argo-secret-token-abcdef12345';
  const rawK8sSecret = 'k8s-secret-token-abcdef12345';

  beforeEach(async () => {
    jest.restoreAllMocks();
    _resetOrchestrationProviderRegistry();
    _resetOrchestrationQueue(undefined);
    await OrchestrationIntegration.deleteMany({});
    await OrchestrationDelivery.deleteMany({});
    await OrchestrationObservation.deleteMany({});

    const userData = await createTestUser({ role: 'admin' });
    user = userData.user;

    project = await createTestProject(user._id, {
      name: 'Orchestration Durable Project',
      key: 'ORCH',
    });

    const argoEnc = encrypt(rawArgoSecret);
    argoIntegration = await OrchestrationIntegration.create({
      project: project._id,
      name: 'Production ArgoCD',
      provider: ORCHESTRATION_PROVIDER.ARGOCD,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      serverUrl: 'https://argocd.production.internal.domain',
      applicationName: 'payment-service',
      encryptedToken: argoEnc.ciphertext,
      tokenIv: argoEnc.iv,
      tokenAuthTag: argoEnc.authTag,
      tokenHint: '...12345',
      createdBy: user._id,
    });

    const k8sEnc = encrypt(rawK8sSecret);
    k8sIntegration = await OrchestrationIntegration.create({
      project: project._id,
      name: 'Production Kubernetes',
      provider: ORCHESTRATION_PROVIDER.KUBERNETES,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      serverUrl: 'https://k8s.production.internal.domain:6443',
      namespace: 'production',
      encryptedToken: k8sEnc.ciphertext,
      tokenIv: k8sEnc.iv,
      tokenAuthTag: k8sEnc.authTag,
      tokenHint: '...12345',
      createdBy: user._id,
    });
  });

  afterAll(async () => {
    await closeOrchestrationQueue();
  });

  // ============================================================
  // 1. Queue Architecture & Contracts
  // ============================================================
  describe('1. Orchestration Queue Contracts', () => {
    it('initializes BullMQ queue with correct name and retry configuration', () => {
      const queue = getOrchestrationQueue();
      expect(queue).toBeDefined();
      expect(queue.name).toBe('orchestration-events');
      expect(queue.defaultJobOptions.attempts).toBe(5);
      expect(queue.defaultJobOptions.backoff).toEqual({
        type: 'exponential',
        delay: 2000,
      });
    });

    it('enqueues a job containing IDENTIFIERS ONLY (no secrets, no raw payloads, no certs)', async () => {
      const delivery = await OrchestrationDelivery.create({
        integration: argoIntegration._id,
        project: project._id,
        deliveryKey: `${argoIntegration._id}:test-key-1`,
        payloadDigest: 'sha256-payload-digest-1',
        applicationName: 'payment-service',
      });

      const result = await enqueueOrchestrationJob({
        integrationId: argoIntegration._id,
        deliveryId: delivery._id,
        projectId: project._id,
        applicationName: 'payment-service',
        reason: 'webhook',
      });

      expect(result.enqueued).toBe(true);
      expect(result.jobId).toBeDefined();
      expect(result.jobId).not.toContain(':'); // Colons sanitized for BullMQ

      const queue = getOrchestrationQueue();
      const job = await queue.getJob(result.jobId);
      expect(job).toBeDefined();

      // STRICT CHECK: Payload must NOT contain sensitive data
      expect(job.data.integrationId).toBe(String(argoIntegration._id));
      expect(job.data.deliveryId).toBe(String(delivery._id));
      expect(job.data.projectId).toBe(String(project._id));
      expect(job.data.reason).toBe('webhook');
      expect(job.data.applicationName).toBe('payment-service');

      // Verify absence of secrets
      expect(job.data.token).toBeUndefined();
      expect(job.data.encryptedToken).toBeUndefined();
      expect(job.data.caCertificate).toBeUndefined();
      expect(job.data.rawPayload).toBeUndefined();
      expect(job.data.payload).toBeUndefined();
      expect(job.data.headers).toBeUndefined();
      expect(job.data.authorization).toBeUndefined();
    });

    it('creates deterministic, sanitized BullMQ job IDs for deliveries', async () => {
      const fakeDeliveryId = new mongoose.Types.ObjectId();
      const result = await enqueueOrchestrationJob({
        integrationId: argoIntegration._id,
        deliveryId: fakeDeliveryId,
        projectId: project._id,
        reason: 'webhook',
      });

      expect(result.jobId).toBe(`orch-del-${fakeDeliveryId}`);
      expect(result.jobId).not.toMatch(/[:]/);
    });

    it('reports queue health and backlog metrics correctly', async () => {
      const health = await getOrchestrationQueueHealth();
      expect(health.available).toBe(true);
      expect(health.mode).toBe('durable_bullmq');
      expect(health.metrics).toBeDefined();
      expect(typeof health.metrics.waiting).toBe('number');
      expect(typeof health.metrics.totalBacklog).toBe('number');
    });
  });

  // ============================================================
  // 2. Webhook -> Queue Flow
  // ============================================================
  describe('2. Webhook to Queue Integration Flow', () => {
    it('accepts valid webhook, claims delivery, enqueues job, and updates status to queued', async () => {
      const samplePayload = {
        app: {
          metadata: { name: 'payment-service' },
          status: {
            sync: { status: 'Synced', revision: 'git-commit-123' },
            health: { status: 'Healthy' },
          },
        },
      };

      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawArgoSecret)
        .send(samplePayload);

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deliveryId).toBeDefined();
      expect(res.body.data.duplicate).toBe(false);

      const delivery = await OrchestrationDelivery.findById(res.body.data.deliveryId);
      expect(delivery).toBeDefined();
      expect(delivery.status).toBe(ORCHESTRATION_DELIVERY_STATUS.QUEUED);
      expect(delivery.jobId).toBeDefined();
      expect(delivery.jobId).toContain(String(delivery._id));

      // Verify job was enqueued in BullMQ
      const queue = getOrchestrationQueue();
      const job = await queue.getJob(delivery.jobId);
      expect(job).toBeDefined();
      expect(job.data.deliveryId).toBe(String(delivery._id));
      expect(job.data.integrationId).toBe(String(argoIntegration._id));
    });

    it('guarantees delivery idempotency: duplicate webhook returns 202 duplicate: true and does not enqueue duplicate job', async () => {
      const samplePayload = {
        app: {
          metadata: { name: 'payment-service' },
          status: {
            sync: { status: 'Synced', revision: 'git-commit-123' },
            health: { status: 'Healthy' },
          },
        },
      };

      // First delivery
      const res1 = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawArgoSecret)
        .send(samplePayload);
      expect(res1.status).toBe(202);
      expect(res1.body.data.duplicate).toBe(false);

      const firstJobId = res1.body.data.deliveryId;

      // Second identical delivery
      const res2 = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawArgoSecret)
        .send(samplePayload);
      expect(res2.status).toBe(202);
      expect(res2.body.data.duplicate).toBe(true);
      expect(res2.body.data.deliveryId).toBe(firstJobId);

      const totalDeliveries = await OrchestrationDelivery.countDocuments({
        integration: argoIntegration._id,
      });
      expect(totalDeliveries).toBe(1);
    });

    it('returns 503 and marks delivery as failed when queue infrastructure throws', async () => {
      // Temporarily mock getOrchestrationQueue to return null (unavailable)
      _resetOrchestrationQueue(null);

      const samplePayload = {
        app: {
          metadata: { name: 'payment-service' },
          status: { health: { status: 'Healthy' } },
        },
      };

      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawArgoSecret)
        .send(samplePayload);

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('QUEUE_UNAVAILABLE');

      // Verify delivery was recorded with status failed
      const delivery = await OrchestrationDelivery.findOne({
        integration: argoIntegration._id,
      });
      expect(delivery).toBeDefined();
      expect(delivery.status).toBe(ORCHESTRATION_DELIVERY_STATUS.FAILED);
      expect(delivery.errorMessage).toMatch(/Queue infrastructure unavailable/i);

      // Restore queue
      _resetOrchestrationQueue(undefined);
    });
  });

  // ============================================================
  // 3. Worker Processing — Argo CD Workload Observation
  // ============================================================
  describe('3. Worker Processing — Argo CD Observation', () => {
    it('successfully processes Argo CD observation job, persists normalized observation, and updates delivery to succeeded', async () => {
      const delivery = await OrchestrationDelivery.create({
        integration: argoIntegration._id,
        project: project._id,
        deliveryKey: `${argoIntegration._id}:argo-obs-1`,
        payloadDigest: 'sha256-argo-obs-1',
        applicationName: 'payment-service',
        status: ORCHESTRATION_DELIVERY_STATUS.QUEUED,
      });

      // Mock provider fetchWorkloadStatus
      const argoProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.ARGOCD);
      const fetchSpy = jest.spyOn(argoProvider, 'fetchWorkloadStatus').mockResolvedValue({
        applicationName: 'payment-service',
        namespace: 'production',
        syncStatus: 'synced',
        healthStatus: 'healthy',
        revision: 'rev-abc1234',
        operationPhase: 'Succeeded',
        healthMessage: 'Application is healthy',
        resources: [
          { kind: 'Deployment', name: 'payment-api', status: 'Synced', health: 'Healthy' },
        ],
        outOfSyncResources: [],
        hasDrift: false,
      });

      const outcome = await processOrchestrationJob({
        integrationId: String(argoIntegration._id),
        deliveryId: String(delivery._id),
        projectId: String(project._id),
        applicationName: 'payment-service',
        reason: 'webhook',
      });

      expect(outcome.success).toBe(true);
      expect(outcome.healthStatus).toBe('healthy');
      expect(outcome.syncStatus).toBe('synced');
      expect(fetchSpy).toHaveBeenCalled();

      // Verify OrchestrationObservation was persisted
      const observation = await OrchestrationObservation.findById(outcome.observationId);
      expect(observation).toBeDefined();
      expect(observation.provider).toBe(ORCHESTRATION_PROVIDER.ARGOCD);
      expect(observation.environment).toBe(DEPLOYMENT_ENVIRONMENT.PRODUCTION);
      expect(observation.workload.name).toBe('payment-service');
      expect(observation.health.status).toBe('healthy');
      expect(observation.sync.status).toBe('synced');
      expect(observation.sync.revision).toBe('rev-abc1234');
      expect(observation.drift.hasDrift).toBe(false);

      // Verify delivery updated to succeeded
      const updatedDelivery = await OrchestrationDelivery.findById(delivery._id);
      expect(updatedDelivery.status).toBe(ORCHESTRATION_DELIVERY_STATUS.SUCCEEDED);
      expect(updatedDelivery.processedAt).toBeDefined();

      // Verify integration lastHealthCheckAt updated
      const updatedIntegration = await OrchestrationIntegration.findById(argoIntegration._id);
      expect(updatedIntegration.status).toBe(ORCHESTRATION_STATUS.CONNECTED);
      expect(updatedIntegration.lastHealthCheckAt).toBeDefined();

      fetchSpy.mockRestore();
    });

    it('persists drift information when Argo CD application has out of sync resources', async () => {
      const delivery = await OrchestrationDelivery.create({
        integration: argoIntegration._id,
        project: project._id,
        deliveryKey: `${argoIntegration._id}:argo-drift-1`,
        payloadDigest: 'sha256-argo-drift-1',
        applicationName: 'payment-service',
        status: ORCHESTRATION_DELIVERY_STATUS.QUEUED,
      });

      const argoProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.ARGOCD);
      const fetchSpy = jest.spyOn(argoProvider, 'fetchWorkloadStatus').mockResolvedValue({
        applicationName: 'payment-service',
        namespace: 'production',
        syncStatus: 'out_of_sync',
        healthStatus: 'progressing',
        revision: 'rev-drifted',
        resources: [],
        outOfSyncResources: [{ kind: 'Deployment', name: 'payment-api', status: 'OutOfSync' }],
        hasDrift: true,
      });

      const outcome = await processOrchestrationJob({
        integrationId: String(argoIntegration._id),
        deliveryId: String(delivery._id),
        projectId: String(project._id),
        applicationName: 'payment-service',
      });

      expect(outcome.success).toBe(true);

      const observation = await OrchestrationObservation.findById(outcome.observationId);
      expect(observation.sync.status).toBe('out_of_sync');
      expect(observation.drift.hasDrift).toBe(true);

      fetchSpy.mockRestore();
    });
  });

  // ============================================================
  // 4. Worker Processing — Kubernetes Workload Observation
  // ============================================================
  describe('4. Worker Processing — Kubernetes Observation', () => {
    it('successfully processes Kubernetes deployment observation job, normalizes replicas, and persists authoritative record', async () => {
      const k8sProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.KUBERNETES);
      const fetchSpy = jest.spyOn(k8sProvider, 'fetchWorkloadStatus').mockResolvedValue({
        workloadType: 'deployment',
        workloadName: 'payment-api',
        namespace: 'production',
        desiredReplicas: 3,
        readyReplicas: 3,
        availableReplicas: 3,
        updatedReplicas: 3,
        currentRevision: 'payment-api-rev2',
        observedGeneration: 2,
        generation: 2,
        status: 'healthy',
        message: 'All 3 replicas are ready and available',
        containers: [{ name: 'api', image: 'payment-api:v2.0.0', ready: true }],
      });

      const outcome = await processOrchestrationJob({
        integrationId: String(k8sIntegration._id),
        projectId: String(project._id),
        workloadType: 'deployment',
        workloadName: 'payment-api',
        namespace: 'production',
        reason: 'scheduled_reconciliation',
      });

      expect(outcome.success).toBe(true);
      expect(outcome.healthStatus).toBe('healthy');
      expect(outcome.workloadIdentifier).toBe('kubernetes:deployment:production:payment-api');

      const observation = await OrchestrationObservation.findById(outcome.observationId);
      expect(observation).toBeDefined();
      expect(observation.provider).toBe(ORCHESTRATION_PROVIDER.KUBERNETES);
      expect(observation.workload.name).toBe('payment-api');
      expect(observation.workload.kind).toBe('deployment');
      expect(observation.workload.namespace).toBe('production');
      expect(observation.health.status).toBe('healthy');
      expect(observation.runtime.desiredReplicas).toBe(3);
      expect(observation.runtime.readyReplicas).toBe(3);
      expect(observation.runtime.generation).toBe(2);
      expect(observation.runtime.containers).toHaveLength(1);
      expect(observation.drift.hasDrift).toBe(false);

      fetchSpy.mockRestore();
    });

    it('persists runtime drift when Kubernetes replica counts or generations diverge', async () => {
      const k8sProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.KUBERNETES);
      const fetchSpy = jest.spyOn(k8sProvider, 'fetchWorkloadStatus').mockResolvedValue({
        workloadType: 'deployment',
        workloadName: 'payment-api',
        namespace: 'production',
        desiredReplicas: 3,
        readyReplicas: 1,
        availableReplicas: 1,
        updatedReplicas: 1,
        generation: 5,
        observedGeneration: 4,
        status: 'progressing',
        message: 'Rollout in progress: waiting for generation 5',
        containers: [],
      });

      const outcome = await processOrchestrationJob({
        integrationId: String(k8sIntegration._id),
        projectId: String(project._id),
        workloadType: 'deployment',
        workloadName: 'payment-api',
        namespace: 'production',
      });

      expect(outcome.success).toBe(true);
      const observation = await OrchestrationObservation.findById(outcome.observationId);
      expect(observation.health.status).toBe('progressing');
      expect(observation.drift.hasDrift).toBe(true);
      expect(observation.drift.reasons.length).toBeGreaterThan(0);

      fetchSpy.mockRestore();
    });
  });

  // ============================================================
  // 5. Authoritative Observation Upsert & Idempotency
  // ============================================================
  describe('5. Authoritative Observation Upsert & Idempotency', () => {
    it('updates existing observation atomically without creating duplicate documents for the same workload', async () => {
      const k8sProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.KUBERNETES);
      const fetchSpy = jest.spyOn(k8sProvider, 'fetchWorkloadStatus');

      // First run: progressing
      fetchSpy.mockResolvedValueOnce({
        workloadType: 'deployment',
        workloadName: 'payment-api',
        namespace: 'production',
        desiredReplicas: 3,
        readyReplicas: 1,
        status: 'progressing',
        message: 'Scaling up',
        containers: [],
      });

      const res1 = await processOrchestrationJob({
        integrationId: String(k8sIntegration._id),
        projectId: String(project._id),
        workloadType: 'deployment',
        workloadName: 'payment-api',
        namespace: 'production',
      });

      // Second run: healthy
      fetchSpy.mockResolvedValueOnce({
        workloadType: 'deployment',
        workloadName: 'payment-api',
        namespace: 'production',
        desiredReplicas: 3,
        readyReplicas: 3,
        status: 'healthy',
        message: 'All replicas ready',
        containers: [],
      });

      const res2 = await processOrchestrationJob({
        integrationId: String(k8sIntegration._id),
        projectId: String(project._id),
        workloadType: 'deployment',
        workloadName: 'payment-api',
        namespace: 'production',
      });

      expect(res1.observationId.toString()).toBe(res2.observationId.toString());

      const count = await OrchestrationObservation.countDocuments({
        integration: k8sIntegration._id,
        workloadIdentifier: 'kubernetes:deployment:production:payment-api',
      });
      expect(count).toBe(1);

      const latest = await OrchestrationObservation.findById(res1.observationId);
      expect(latest.health.status).toBe('healthy');
      expect(latest.health.message).toBe('All replicas ready');

      fetchSpy.mockRestore();
    });

    it('CRITICAL: Never persists raw manifests, raw API responses, or credentials in MongoDB', async () => {
      const k8sProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.KUBERNETES);
      const fetchSpy = jest.spyOn(k8sProvider, 'fetchWorkloadStatus').mockResolvedValue({
        workloadType: 'deployment',
        workloadName: 'secure-workload',
        namespace: 'production',
        desiredReplicas: 1,
        readyReplicas: 1,
        status: 'healthy',
        message: 'Ready',
        containers: [{ name: 'secure-app', image: 'app:1.0' }],
      });

      const outcome = await processOrchestrationJob({
        integrationId: String(k8sIntegration._id),
        projectId: String(project._id),
        workloadType: 'deployment',
        workloadName: 'secure-workload',
      });

      const doc = await OrchestrationObservation.findById(outcome.observationId).lean();
      const docStr = JSON.stringify(doc);

      // Verify absence of sensitive words or raw k8s objects
      expect(docStr).not.toContain(rawK8sSecret);
      expect(docStr).not.toContain('apiVersion');
      expect(docStr).not.toContain('spec');
      expect(docStr).not.toContain('metadata');
      expect(docStr).not.toContain('clusterIP');
      expect(doc.token).toBeUndefined();
      expect(doc.encryptedToken).toBeUndefined();

      fetchSpy.mockRestore();
    });
  });

  // ============================================================
  // 6. Retries, Transient vs Permanent Failures
  // ============================================================
  describe('6. Retries & Error Handling', () => {
    it('classifies network timeouts and 5xx errors as transient for bounded retry', () => {
      const timeoutErr = new Error('Argo CD API request timed out');
      expect(isTransientError(timeoutErr)).toBe(true);

      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      expect(isTransientError(abortErr)).toBe(true);

      const connResetErr = new Error('read ECONNRESET');
      expect(isTransientError(connResetErr)).toBe(true);

      const server503Err = new Error('HTTP 503 Service Unavailable');
      expect(isTransientError(server503Err)).toBe(true);
    });

    it('classifies auth, 404, SSRF, and validation errors as non-transient (UnrecoverableError)', () => {
      const authErr = new Error('Invalid credentials or token expired');
      expect(isTransientError(authErr)).toBe(false);

      const notFoundErr = new Error('Argo CD application not found');
      expect(isTransientError(notFoundErr)).toBe(false);

      const ssrfErr = new Error('Access to private IP addresses is blocked');
      expect(isTransientError(ssrfErr)).toBe(false);

      const unrecoverable = new UnrecoverableError('Permanent failure');
      expect(isTransientError(unrecoverable)).toBe(false);
    });

    it('throws UnrecoverableError and marks delivery failed on permanent provider errors', async () => {
      const delivery = await OrchestrationDelivery.create({
        integration: argoIntegration._id,
        project: project._id,
        deliveryKey: `${argoIntegration._id}:perm-fail-1`,
        payloadDigest: 'sha256-perm-fail',
        applicationName: 'nonexistent-app',
      });

      const argoProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.ARGOCD);
      const fetchSpy = jest
        .spyOn(argoProvider, 'fetchWorkloadStatus')
        .mockRejectedValue(new Error('Argo CD application not found (404)'));

      await expect(
        processOrchestrationJob({
          integrationId: String(argoIntegration._id),
          deliveryId: String(delivery._id),
          applicationName: 'nonexistent-app',
        })
      ).rejects.toThrow(UnrecoverableError);

      const updatedDelivery = await OrchestrationDelivery.findById(delivery._id);
      expect(updatedDelivery.status).toBe(ORCHESTRATION_DELIVERY_STATUS.FAILED);
      expect(updatedDelivery.errorMessage).toMatch(/not found/i);

      fetchSpy.mockRestore();
    });

    it('throws standard Error on transient errors to trigger BullMQ exponential backoff', async () => {
      const delivery = await OrchestrationDelivery.create({
        integration: argoIntegration._id,
        project: project._id,
        deliveryKey: `${argoIntegration._id}:trans-fail-1`,
        payloadDigest: 'sha256-trans-fail',
        applicationName: 'payment-service',
      });

      const argoProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.ARGOCD);
      const timeoutErr = new Error('Argo CD API request timed out');
      const fetchSpy = jest
        .spyOn(argoProvider, 'fetchWorkloadStatus')
        .mockRejectedValue(timeoutErr);

      let caughtErr = null;
      try {
        await processOrchestrationJob({
          integrationId: String(argoIntegration._id),
          deliveryId: String(delivery._id),
          applicationName: 'payment-service',
        });
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr instanceof UnrecoverableError).toBe(false);
      expect(caughtErr instanceof Error).toBe(true);

      fetchSpy.mockRestore();
    });
  });

  // ============================================================
  // 7. Reconciliation Scheduler
  // ============================================================
  describe('7. Reconciliation Scheduler', () => {
    it('discovers all active integrations and enqueues reconciliation jobs without calling providers directly', async () => {
      const argoProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.ARGOCD);
      const k8sProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.KUBERNETES);
      const argoSpy = jest.spyOn(argoProvider, 'fetchWorkloadStatus');
      const k8sSpy = jest.spyOn(k8sProvider, 'fetchWorkloadStatus');

      const result = await processScheduledReconciliation();
      expect(result.scheduledCount).toBe(2); // argoIntegration and k8sIntegration

      // Scheduler must NEVER call providers directly
      expect(argoSpy).not.toHaveBeenCalled();
      expect(k8sSpy).not.toHaveBeenCalled();

      argoSpy.mockRestore();
      k8sSpy.mockRestore();
    });

    it('registers repeatable reconciliation schedule with BullMQ cleanly', async () => {
      await expect(scheduleRepeatableOrchestrationReconciliation()).resolves.not.toThrow();
    });
  });

  // ============================================================
  // 8. Security & Credential Isolation
  // ============================================================
  describe('8. Security & Credential Isolation', () => {
    it('sanitizes error messages so decrypted tokens never appear in logs or errors', () => {
      const secret = 'super-secret-k8s-bearer-token-12345';
      const rawError = `Failed to connect to cluster: Bearer ${secret} was rejected by API`;

      const safe = sanitizeErrorMessage(rawError, secret);
      expect(safe).not.toContain(secret);
      expect(safe).toContain('[REDACTED]');
    });

    it('rejects jobs for deleted or non-existent integrations safely', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await expect(
        processOrchestrationJob({
          integrationId: String(fakeId),
        })
      ).rejects.toThrow(UnrecoverableError);

      await OrchestrationIntegration.findByIdAndUpdate(argoIntegration._id, {
        status: 'deleted',
      });

      await expect(
        processOrchestrationJob({
          integrationId: String(argoIntegration._id),
        })
      ).rejects.toThrow(/deleted/i);
    });

    it('decrypts token strictly at the provider call boundary and does not leak it', async () => {
      const argoProvider = getOrchestrationProvider(ORCHESTRATION_PROVIDER.ARGOCD);
      let capturedToken = null;
      const fetchSpy = jest
        .spyOn(argoProvider, 'fetchWorkloadStatus')
        .mockImplementation((params) => {
          capturedToken = params.token;
          return Promise.resolve({
            applicationName: 'payment-service',
            syncStatus: 'synced',
            healthStatus: 'healthy',
            resources: [],
            outOfSyncResources: [],
          });
        });

      await processOrchestrationJob({
        integrationId: String(argoIntegration._id),
        applicationName: 'payment-service',
      });

      // Provider received decrypted token at the call boundary
      expect(capturedToken).toBe(rawArgoSecret);

      fetchSpy.mockRestore();
    });
  });
});

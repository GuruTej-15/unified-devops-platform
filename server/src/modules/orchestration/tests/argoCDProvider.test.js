import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../../app.js';
import BaseOrchestrationProvider from '../providers/baseOrchestrationProvider.js';
import ArgoCDProvider, {
  normalizeArgoSyncStatus,
  normalizeArgoHealthStatus,
} from '../providers/argoCDProvider.js';
import {
  getOrchestrationProvider,
  hasOrchestrationProvider,
  _resetOrchestrationProviderRegistry,
} from '../providers/orchestrationProviderRegistry.js';
import OrchestrationIntegration from '../orchestrationIntegration.model.js';
import OrchestrationDelivery from '../orchestrationDelivery.model.js';
import AuditLog from '../../audit/audit.model.js';
import { createTestUser, createTestProject } from '../../../../tests/helpers.js';
import { encrypt, decrypt } from '../../../shared/crypto.js';
import {
  ORCHESTRATION_PROVIDER,
  ORCHESTRATION_STATUS,
  DEPLOYMENT_ENVIRONMENT,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
} from '../../../shared/constants.js';

describe('Phase 4 Step 2 — Argo CD Provider & Webhook Ingestion (Simulated/Mock Provider Tests)', () => {
  let user;
  let project;
  let otherProject;
  let argoIntegration;
  let rawSecretToken;

  const sampleArgoApp = {
    metadata: {
      name: 'payment-service',
      namespace: 'argocd',
      uid: 'app-uid-12345',
    },
    spec: {
      project: 'default',
      source: {
        repoURL: 'https://github.com/example/payments.git',
        targetRevision: 'main',
      },
      destination: {
        namespace: 'production',
        server: 'https://kubernetes.default.svc',
      },
    },
    status: {
      sync: {
        status: 'Synced',
        revision: '7b8c9d0e1f2a3b4c',
      },
      health: {
        status: 'Healthy',
        message: 'All deployments are healthy',
      },
      operationState: {
        phase: 'Succeeded',
        message: 'Sync succeeded at revision 7b8c9d0e1f2a3b4c',
        syncResult: {
          revision: '7b8c9d0e1f2a3b4c',
        },
      },
      resources: [
        {
          group: 'apps',
          version: 'v1',
          kind: 'Deployment',
          namespace: 'production',
          name: 'payment-api',
          status: 'Synced',
          health: { status: 'Healthy', message: 'Deployment is available' },
        },
        {
          group: '',
          version: 'v1',
          kind: 'Service',
          namespace: 'production',
          name: 'payment-api-svc',
          status: 'Synced',
          health: { status: 'Healthy' },
        },
      ],
    },
  };

  beforeEach(async () => {
    _resetOrchestrationProviderRegistry();

    const userData = await createTestUser({ role: 'admin' });
    user = userData.user;

    project = await createTestProject(user._id, {
      name: 'ArgoCD Platform Project',
      key: 'ARGO',
    });

    otherProject = await createTestProject(user._id, {
      name: 'Other Isolated Project',
      key: 'OTHER',
    });

    rawSecretToken = 'super-secret-argo-auth-token-12345';
    const enc = encrypt(rawSecretToken);

    argoIntegration = await OrchestrationIntegration.create({
      project: project._id,
      name: 'Production ArgoCD',
      provider: ORCHESTRATION_PROVIDER.ARGOCD,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      serverUrl: 'https://argocd.production.internal.domain',
      applicationName: 'payment-service',
      encryptedToken: enc.ciphertext,
      tokenIv: enc.iv,
      tokenAuthTag: enc.authTag,
      tokenHint: '••••••••2345',
      status: ORCHESTRATION_STATUS.CONNECTED,
      createdBy: user._id,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ============================================================
  // 1. Base Provider Contract
  // ============================================================
  describe('1. Base Provider Contract', () => {
    class IncompleteProvider extends BaseOrchestrationProvider {}

    it('throws errors when abstract methods are not implemented', async () => {
      const incomplete = new IncompleteProvider();

      expect(() => incomplete.getProviderName()).toThrow(
        'getProviderName() must be implemented by subclass'
      );
      await expect(incomplete.testConnection()).rejects.toThrow(
        'testConnection() must be implemented by subclass'
      );
      await expect(incomplete.fetchWorkloadStatus()).rejects.toThrow(
        'fetchWorkloadStatus() must be implemented by subclass'
      );
      expect(() => incomplete.normalizeWorkloadStatus()).toThrow(
        'normalizeWorkloadStatus() must be implemented by subclass'
      );
      expect(() => incomplete.detectDrift()).toThrow(
        'detectDrift() must be implemented by subclass'
      );
    });

    it('ArgoCDProvider extends BaseOrchestrationProvider and implements contract', () => {
      const provider = new ArgoCDProvider();
      expect(provider).toBeInstanceOf(BaseOrchestrationProvider);
      expect(provider.getProviderName()).toBe('argocd');
    });
  });

  // ============================================================
  // 2. Registry Resolves Argo CD Provider
  // ============================================================
  describe('2. Registry Resolves Argo CD Provider', () => {
    it('resolves argocd provider adapter from registry', () => {
      const provider = getOrchestrationProvider('argocd');
      expect(provider).toBeInstanceOf(ArgoCDProvider);
      expect(provider.getProviderName()).toBe('argocd');
      expect(hasOrchestrationProvider('argocd')).toBe(true);
    });
  });

  // ============================================================
  // 3. Unsupported Provider Rejection
  // ============================================================
  describe('3. Unsupported Provider Rejection', () => {
    it('rejects kubernetes provider in Step 2 since it is not registered yet', () => {
      expect(() => getOrchestrationProvider('kubernetes')).toThrow(
        /Unsupported orchestration provider: 'kubernetes'/
      );
      expect(hasOrchestrationProvider('kubernetes')).toBe(false);
    });

    it('rejects unknown or invalid provider strings with controlled errors', () => {
      expect(() => getOrchestrationProvider('flux')).toThrow(
        /Unsupported orchestration provider: 'flux'/
      );
      expect(() => getOrchestrationProvider('')).toThrow(/Invalid provider name/);
      expect(() => getOrchestrationProvider(null)).toThrow(/Invalid provider name/);
    });
  });

  // ============================================================
  // 4. Argo CD Response Normalization
  // ============================================================
  describe('4. Argo CD Response Normalization', () => {
    it('normalizes realistic Argo CD application response into standard platform schema', () => {
      const provider = new ArgoCDProvider();
      const normalized = provider.normalizeWorkloadStatus(sampleArgoApp);

      expect(normalized).toEqual({
        applicationName: 'payment-service',
        namespace: 'argocd',
        syncStatus: 'synced',
        healthStatus: 'healthy',
        revision: '7b8c9d0e1f2a3b4c',
        operationPhase: 'succeeded',
        healthMessage: 'All deployments are healthy',
        operationMessage: 'Sync succeeded at revision 7b8c9d0e1f2a3b4c',
        resources: [
          {
            group: 'apps',
            version: 'v1',
            kind: 'Deployment',
            namespace: 'production',
            name: 'payment-api',
            status: 'synced',
            healthStatus: 'healthy',
            message: 'Deployment is available',
          },
          {
            group: '',
            version: 'v1',
            kind: 'Service',
            namespace: 'production',
            name: 'payment-api-svc',
            status: 'synced',
            healthStatus: 'healthy',
            message: '',
          },
        ],
        outOfSyncResources: [],
        hasDrift: false,
      });

      // Does not retain raw Argo CD fields (e.g. metadata.uid, spec.source)
      expect(normalized.metadata).toBeUndefined();
      expect(normalized.spec).toBeUndefined();
      expect(normalized.status).toBeUndefined();
    });
  });

  // ============================================================
  // 5. Sync Status Normalization
  // ============================================================
  describe('5. Sync Status Normalization', () => {
    it('normalizes various sync statuses accurately', () => {
      expect(normalizeArgoSyncStatus('Synced')).toBe('synced');
      expect(normalizeArgoSyncStatus('synced')).toBe('synced');
      expect(normalizeArgoSyncStatus('OutOfSync')).toBe('out_of_sync');
      expect(normalizeArgoSyncStatus('out-of-sync')).toBe('out_of_sync');
      expect(normalizeArgoSyncStatus('Unknown')).toBe('unknown');
      expect(normalizeArgoSyncStatus(null)).toBe('unknown');
      expect(normalizeArgoSyncStatus('NonStandard')).toBe('unknown');
    });
  });

  // ============================================================
  // 6. Health Normalization
  // ============================================================
  describe('6. Health Normalization', () => {
    it('normalizes various Argo CD health statuses', () => {
      expect(normalizeArgoHealthStatus('Healthy')).toBe('healthy');
      expect(normalizeArgoHealthStatus('Progressing')).toBe('progressing');
      expect(normalizeArgoHealthStatus('Degraded')).toBe('degraded');
      expect(normalizeArgoHealthStatus('Suspended')).toBe('suspended');
      expect(normalizeArgoHealthStatus('Missing')).toBe('missing');
      expect(normalizeArgoHealthStatus('Unknown')).toBe('unknown');
      expect(normalizeArgoHealthStatus(null)).toBe('unknown');
      expect(normalizeArgoHealthStatus('Other')).toBe('unknown');
    });
  });

  // ============================================================
  // 7. Revision Extraction
  // ============================================================
  describe('7. Revision Extraction', () => {
    it('extracts revision from sync status, operationResult, or top-level', () => {
      const provider = new ArgoCDProvider();

      const fromSync = provider.normalizeWorkloadStatus({
        status: { sync: { revision: 'sha-from-sync' } },
      });
      expect(fromSync.revision).toBe('sha-from-sync');

      const fromOp = provider.normalizeWorkloadStatus({
        status: { operationState: { syncResult: { revision: 'sha-from-op' } } },
      });
      expect(fromOp.revision).toBe('sha-from-op');

      const fromTop = provider.normalizeWorkloadStatus({
        revision: 'sha-from-top',
      });
      expect(fromTop.revision).toBe('sha-from-top');
    });
  });

  // ============================================================
  // 8. Drift / Out-of-Sync Resource Extraction
  // ============================================================
  describe('8. Drift / Out-of-Sync Resource Extraction', () => {
    it('detects drift when top-level syncStatus is OutOfSync', () => {
      const provider = new ArgoCDProvider();
      const raw = {
        metadata: { name: 'app-drift' },
        status: {
          sync: { status: 'OutOfSync' },
          resources: [{ kind: 'Deployment', name: 'app-deploy', status: 'Synced' }],
        },
      };

      const result = provider.detectDrift(raw);
      expect(result.hasDrift).toBe(true);
      expect(result.outOfSyncResources).toHaveLength(0);
    });

    it('detects drift and lists out-of-sync resources when individual resource is OutOfSync', () => {
      const provider = new ArgoCDProvider();
      const raw = {
        metadata: { name: 'app-resource-drift' },
        status: {
          sync: { status: 'Synced' },
          resources: [
            {
              group: 'apps',
              kind: 'Deployment',
              name: 'web-deploy',
              namespace: 'prod',
              status: 'OutOfSync',
              health: { status: 'Progressing' },
            },
            {
              group: '',
              kind: 'Service',
              name: 'web-svc',
              namespace: 'prod',
              status: 'Synced',
              health: { status: 'Healthy' },
            },
          ],
        },
      };

      const result = provider.detectDrift(raw);
      expect(result.hasDrift).toBe(true);
      expect(result.outOfSyncResources).toHaveLength(1);
      expect(result.outOfSyncResources[0].name).toBe('web-deploy');
      expect(result.outOfSyncResources[0].status).toBe('out_of_sync');
      expect(result.outOfSyncResources[0].healthStatus).toBe('progressing');
    });

    it('returns hasDrift: false when all resources are Synced', () => {
      const provider = new ArgoCDProvider();
      const result = provider.detectDrift(sampleArgoApp);
      expect(result.hasDrift).toBe(false);
      expect(result.outOfSyncResources).toHaveLength(0);
    });
  });

  // ============================================================
  // 9. Missing Optional Fields
  // ============================================================
  describe('9. Missing Optional Fields', () => {
    it('handles empty or sparse payloads safely without errors', () => {
      const provider = new ArgoCDProvider();

      const emptyResult = provider.normalizeWorkloadStatus({});
      expect(emptyResult.applicationName).toBe('');
      expect(emptyResult.syncStatus).toBe('unknown');
      expect(emptyResult.healthStatus).toBe('unknown');
      expect(emptyResult.revision).toBeNull();
      expect(emptyResult.resources).toEqual([]);
      expect(emptyResult.hasDrift).toBe(false);

      const nullResult = provider.normalizeWorkloadStatus(null);
      expect(nullResult.syncStatus).toBe('unknown');
      expect(nullResult.hasDrift).toBe(false);

      const minimalResult = provider.normalizeWorkloadStatus({
        metadata: { name: 'sparse-app' },
      });
      expect(minimalResult.applicationName).toBe('sparse-app');
      expect(minimalResult.syncStatus).toBe('unknown');
    });
  });

  // ============================================================
  // 10. Argo CD API Timeout
  // ============================================================
  describe('10. Argo CD API Timeout', () => {
    it('aborts request and throws clean timeout error on delayed response', async () => {
      const provider = new ArgoCDProvider();

      jest.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      await expect(
        provider.fetchWorkloadStatus({
          serverUrl: 'https://argocd.production.internal.domain',
          token: rawSecretToken,
          applicationName: 'payment-service',
          timeoutMs: 50,
        })
      ).rejects.toThrow('Argo CD API request timed out');
    });
  });

  // ============================================================
  // 11. SSRF Protection
  // ============================================================
  describe('11. SSRF Protection', () => {
    it('rejects cloud metadata IP addresses (169.254.169.254)', async () => {
      const provider = new ArgoCDProvider();

      await expect(
        provider.fetchWorkloadStatus({
          serverUrl: 'http://169.254.169.254/latest/meta-data',
          token: rawSecretToken,
          applicationName: 'payment-service',
        })
      ).rejects.toThrow(
        /SSRF Protection: Access to cloud metadata network addresses is strictly prohibited/
      );
    });

    it('rejects cloud metadata hostname (metadata.google.internal)', async () => {
      const provider = new ArgoCDProvider();

      await expect(
        provider.fetchWorkloadStatus({
          serverUrl: 'http://metadata.google.internal',
          token: rawSecretToken,
          applicationName: 'payment-service',
        })
      ).rejects.toThrow(
        /SSRF Protection: Access to cloud metadata network addresses is strictly prohibited/
      );
    });
  });

  // ============================================================
  // 12. Credential Decryption
  // ============================================================
  describe('12. Credential Decryption', () => {
    it('decrypts token at integration boundary and performs authenticated fetch', async () => {
      const provider = new ArgoCDProvider();

      const integrationDoc = await OrchestrationIntegration.findById(argoIntegration._id).select(
        '+encryptedToken +tokenIv +tokenAuthTag'
      );

      const decryptedToken = decrypt({
        ciphertext: integrationDoc.encryptedToken,
        iv: integrationDoc.tokenIv,
        authTag: integrationDoc.tokenAuthTag,
      });

      expect(decryptedToken).toBe(rawSecretToken);

      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleArgoApp,
      });

      const status = await provider.fetchWorkloadStatus({
        serverUrl: integrationDoc.serverUrl,
        token: decryptedToken,
        applicationName: integrationDoc.applicationName,
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://argocd.production.internal.domain/api/v1/applications/payment-service',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${rawSecretToken}`,
          }),
        })
      );
      expect(status.applicationName).toBe('payment-service');
      expect(status.syncStatus).toBe('synced');
    });
  });

  // ============================================================
  // 13. Token Never Appears in Logs/Errors
  // ============================================================
  describe('13. Token Never Appears in Logs/Errors', () => {
    it('sanitizes error messages when Argo CD API fails', async () => {
      const provider = new ArgoCDProvider();

      jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({
          message: `Internal server failure involving token ${rawSecretToken}`,
        }),
      });

      let caughtErr = null;
      try {
        await provider.fetchWorkloadStatus({
          serverUrl: 'https://argocd.production.internal.domain',
          token: rawSecretToken,
          applicationName: 'payment-service',
        });
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr.message).not.toContain(rawSecretToken);
      expect(caughtErr.message).toContain('[REDACTED]');
    });
  });

  // ============================================================
  // 14. Valid Webhook Authentication
  // ============================================================
  describe('14. Valid Webhook Authentication', () => {
    it('accepts webhook with correct X-Orchestration-Token header and returns 202', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawSecretToken)
        .send(sampleArgoApp);

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Orchestration webhook accepted');
      expect(res.body.data.deliveryId).toBeDefined();
      expect(res.body.data.duplicate).toBe(false);
      expect(res.body.data.status).toBe('claimed');
    });
  });

  // ============================================================
  // 15. Invalid Token -> 401
  // ============================================================
  describe('15. Invalid Token -> 401', () => {
    it('returns 401 when X-Orchestration-Token is incorrect', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', 'wrong-token-abc')
        .send(sampleArgoApp);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invalid or missing orchestration token');
    });

    it('returns 401 when X-Orchestration-Token header is missing', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .send(sampleArgoApp);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invalid or missing orchestration token');
    });
  });

  // ============================================================
  // 16. Malformed Payload -> 400
  // ============================================================
  describe('16. Malformed Payload -> 400', () => {
    it('returns 400 when body is an empty object', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawSecretToken)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Malformed webhook payload/);
    });

    it('returns 400 when body is an array', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawSecretToken)
        .send([1, 2, 3]);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ============================================================
  // 17. Unknown Integration -> 404
  // ============================================================
  describe('17. Unknown Integration -> 404', () => {
    it('returns 404 when integrationId does not exist in DB', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${nonExistentId}`)
        .set('X-Orchestration-Token', rawSecretToken)
        .send(sampleArgoApp);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Orchestration integration not found');
    });

    it('returns 404 when integrationId is an invalid ObjectId', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks/orchestration/invalid-object-id-123')
        .set('X-Orchestration-Token', rawSecretToken)
        .send(sampleArgoApp);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Orchestration integration not found');
    });
  });

  // ============================================================
  // 18. Wrong Provider -> 400
  // ============================================================
  describe('18. Wrong Provider -> 400', () => {
    it('returns 400 when integration provider is kubernetes instead of argocd', async () => {
      const k8sEnc = encrypt('k8s-token-1234567890');
      const k8sIntegration = await OrchestrationIntegration.create({
        project: project._id,
        name: 'K8s Cluster Integration',
        provider: ORCHESTRATION_PROVIDER.KUBERNETES,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        serverUrl: 'https://k8s.example.com:6443',
        namespace: 'default',
        encryptedToken: k8sEnc.ciphertext,
        tokenIv: k8sEnc.iv,
        tokenAuthTag: k8sEnc.authTag,
        createdBy: user._id,
      });

      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${k8sIntegration._id}`)
        .set('X-Orchestration-Token', 'k8s-token-1234567890')
        .send(sampleArgoApp);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Unsupported orchestration provider: 'kubernetes'/);
    });
  });

  // ============================================================
  // 19. First Webhook Delivery -> Accepted
  // ============================================================
  describe('19. First Webhook Delivery -> Accepted', () => {
    it('persists OrchestrationDelivery with status claimed and returns 202', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawSecretToken)
        .send(sampleArgoApp);

      expect(res.status).toBe(202);
      expect(res.body.data.duplicate).toBe(false);

      const delivery = await OrchestrationDelivery.findById(res.body.data.deliveryId);
      expect(delivery).toBeDefined();
      expect(delivery.status).toBe('claimed');
      expect(delivery.integration.toString()).toBe(argoIntegration._id.toString());
      expect(delivery.project.toString()).toBe(project._id.toString());
      expect(delivery.applicationName).toBe('payment-service');
      expect(delivery.deliveryKey).toBeDefined();
    });
  });

  // ============================================================
  // 20. Duplicate Webhook -> Idempotent
  // ============================================================
  describe('20. Duplicate Webhook -> Idempotent', () => {
    it('safely handles repeated identical deliveries without creating duplicates', async () => {
      const res1 = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawSecretToken)
        .send(sampleArgoApp);

      expect(res1.status).toBe(202);
      expect(res1.body.data.duplicate).toBe(false);

      const res2 = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawSecretToken)
        .send(sampleArgoApp);

      expect(res2.status).toBe(202);
      expect(res2.body.data.duplicate).toBe(true);
      expect(res2.body.data.deliveryId).toBe(res1.body.data.deliveryId);
      expect(res2.body.message).toMatch(/already claimed/);

      const count = await OrchestrationDelivery.countDocuments({
        integration: argoIntegration._id,
      });
      expect(count).toBe(1);
    });
  });

  // ============================================================
  // 21. Atomic Delivery Claim
  // ============================================================
  describe('21. Atomic Delivery Claim', () => {
    it('allows reclamation if a previous delivery attempt failed', async () => {
      const deliveryKey = `${argoIntegration._id}:test-failed-claim`;

      // Simulate a previously failed delivery
      const failedDelivery = await OrchestrationDelivery.create({
        integration: argoIntegration._id,
        project: project._id,
        deliveryKey,
        payloadDigest: 'digest-12345',
        applicationName: 'payment-service',
        status: 'failed',
        errorMessage: 'Worker encountered transient error',
      });

      // Claim again using static claimDelivery
      const claim = await OrchestrationDelivery.claimDelivery({
        integrationId: argoIntegration._id,
        projectId: project._id,
        deliveryKey,
        payloadDigest: 'digest-12345',
        applicationName: 'payment-service',
      });

      expect(claim.claimed).toBe(true);
      expect(claim.duplicate).toBe(false);
      expect(claim.delivery._id.toString()).toBe(failedDelivery._id.toString());
      expect(claim.delivery.status).toBe('claimed');
      expect(claim.delivery.errorMessage).toBe('');
    });
  });

  // ============================================================
  // 22. Project Isolation
  // ============================================================
  describe('22. Project Isolation', () => {
    it('isolates deliveries between different projects even with identical payloads', async () => {
      const otherEnc = encrypt('other-secret-argo-token');
      const otherArgoIntegration = await OrchestrationIntegration.create({
        project: otherProject._id,
        name: 'Other Project ArgoCD',
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        serverUrl: 'https://argocd.production.internal.domain',
        applicationName: 'payment-service',
        encryptedToken: otherEnc.ciphertext,
        tokenIv: otherEnc.iv,
        tokenAuthTag: otherEnc.authTag,
        createdBy: user._id,
      });

      // Webhook to first integration
      const res1 = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawSecretToken)
        .send(sampleArgoApp);

      // Webhook to second integration with same payload
      const res2 = await request(app)
        .post(`/api/v1/webhooks/orchestration/${otherArgoIntegration._id}`)
        .set('X-Orchestration-Token', 'other-secret-argo-token')
        .send(sampleArgoApp);

      expect(res1.status).toBe(202);
      expect(res2.status).toBe(202);

      const d1 = await OrchestrationDelivery.findById(res1.body.data.deliveryId);
      const d2 = await OrchestrationDelivery.findById(res2.body.data.deliveryId);

      expect(d1.project.toString()).toBe(project._id.toString());
      expect(d2.project.toString()).toBe(otherProject._id.toString());
      expect(d1._id.toString()).not.toBe(d2._id.toString());
    });
  });

  // ============================================================
  // 23. Webhook Cannot Override Project
  // ============================================================
  describe('23. Webhook Cannot Override Project', () => {
    it('ignores spoofed projectId in webhook payload and authoritatively binds integration project', async () => {
      const spoofedProjectId = new mongoose.Types.ObjectId();

      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawSecretToken)
        .send({
          ...sampleArgoApp,
          projectId: spoofedProjectId.toString(),
        });

      expect(res.status).toBe(202);
      const delivery = await OrchestrationDelivery.findById(res.body.data.deliveryId);
      expect(delivery.project.toString()).toBe(project._id.toString());
      expect(delivery.project.toString()).not.toBe(spoofedProjectId.toString());
    });
  });

  // ============================================================
  // 24. Webhook Cannot Override Server URL
  // ============================================================
  describe('24. Webhook Cannot Override Server URL', () => {
    it('ignores serverUrl passed in payload; provider uses integration serverUrl', async () => {
      const spoofedUrl = 'http://attacker-controlled-server.com';

      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawSecretToken)
        .send({
          ...sampleArgoApp,
          serverUrl: spoofedUrl,
        });

      expect(res.status).toBe(202);
      const unchangedIntegration = await OrchestrationIntegration.findById(argoIntegration._id);
      expect(unchangedIntegration.serverUrl).toBe('https://argocd.production.internal.domain');
      expect(unchangedIntegration.serverUrl).not.toBe(spoofedUrl);
    });
  });

  // ============================================================
  // 25. Audit Safety
  // ============================================================
  describe('25. Audit Safety', () => {
    it('logs audit event with safe metadata without exposing tokens or credentials', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/orchestration/${argoIntegration._id}`)
        .set('X-Orchestration-Token', rawSecretToken)
        .send(sampleArgoApp);

      expect(res.status).toBe(202);

      const audit = await AuditLog.findOne({
        action: AUDIT_ACTIONS.ORCHESTRATION_WEBHOOK_RECEIVED,
        entityId: res.body.data.deliveryId,
      });

      expect(audit).toBeDefined();
      expect(audit.entityType).toBe(ENTITY_TYPES.ORCHESTRATION_DELIVERY);
      expect(audit.projectId.toString()).toBe(project._id.toString());
      expect(audit.metadata).toEqual(
        expect.objectContaining({
          integrationId: argoIntegration._id,
          provider: 'argocd',
          applicationName: 'payment-service',
          status: 'claimed',
        })
      );

      // Verify no tokens or sensitive credential fields exist in audit
      const auditJson = JSON.stringify(audit);
      expect(auditJson).not.toContain(rawSecretToken);
      expect(audit.metadata.token).toBeUndefined();
      expect(audit.metadata.encryptedToken).toBeUndefined();
      expect(audit.metadata.headers).toBeUndefined();
    });
  });
});

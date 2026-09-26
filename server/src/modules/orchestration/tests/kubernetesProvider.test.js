import { jest } from '@jest/globals';
import BaseOrchestrationProvider from '../providers/baseOrchestrationProvider.js';
import KubernetesProvider from '../providers/kubernetesProvider.js';
import ArgoCDProvider from '../providers/argoCDProvider.js';
import {
  getOrchestrationProvider,
  hasOrchestrationProvider,
  _resetOrchestrationProviderRegistry,
} from '../providers/orchestrationProviderRegistry.js';
import OrchestrationIntegration from '../orchestrationIntegration.model.js';
import { createTestUser, createTestProject } from '../../../../tests/helpers.js';
import { encrypt, decrypt } from '../../../shared/crypto.js';
import {
  ORCHESTRATION_PROVIDER,
  ORCHESTRATION_STATUS,
  DEPLOYMENT_ENVIRONMENT,
} from '../../../shared/constants.js';

describe('Phase 4 Step 3 — Kubernetes Provider & Workload Observation (Simulated/Mock Tests)', () => {
  let user;
  let project;
  let otherProject;
  let k8sIntegration;
  let rawToken;
  let caCert;

  // Realistic Kubernetes manifests
  const sampleDeployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'order-service',
      namespace: 'production',
      generation: 3,
      annotations: {
        'deployment.kubernetes.io/revision': '3',
      },
      uid: 'deploy-uid-12345',
    },
    spec: {
      replicas: 3,
      template: {
        spec: {
          containers: [
            {
              name: 'order-app',
              image: 'order-service:v2.1.0',
            },
          ],
        },
      },
    },
    status: {
      observedGeneration: 3,
      replicas: 3,
      updatedReplicas: 3,
      readyReplicas: 3,
      availableReplicas: 3,
      conditions: [
        {
          type: 'Available',
          status: 'True',
          reason: 'MinimumReplicasAvailable',
          message: 'Deployment has minimum availability.',
        },
        {
          type: 'Progressing',
          status: 'True',
          reason: 'NewReplicaSetAvailable',
          message: 'ReplicaSet order-service-xxx has successfully progressed.',
        },
      ],
    },
  };

  const sampleStatefulSet = {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: 'order-db',
      namespace: 'production',
      generation: 2,
    },
    spec: {
      replicas: 2,
      template: {
        spec: {
          containers: [
            {
              name: 'postgres',
              image: 'postgres:15-alpine',
            },
          ],
        },
      },
    },
    status: {
      observedGeneration: 2,
      replicas: 2,
      readyReplicas: 2,
      currentRevision: 'order-db-rev-2',
      updateRevision: 'order-db-rev-2',
      updatedReplicas: 2,
    },
  };

  const sampleDaemonSet = {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: 'log-collector',
      namespace: 'monitoring',
      generation: 1,
    },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'fluentbit',
              image: 'fluent/fluent-bit:2.1',
            },
          ],
        },
      },
    },
    status: {
      observedGeneration: 1,
      desiredNumberScheduled: 5,
      currentNumberScheduled: 5,
      numberReady: 5,
      numberAvailable: 5,
      numberUnavailable: 0,
      updatedNumberScheduled: 5,
    },
  };

  const samplePod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'order-service-789-abc',
      namespace: 'production',
    },
    spec: {
      containers: [
        {
          name: 'order-app',
          image: 'order-service:v2.1.0',
        },
      ],
    },
    status: {
      phase: 'Running',
      containerStatuses: [
        {
          name: 'order-app',
          image: 'order-service:v2.1.0',
          ready: true,
          restartCount: 0,
          state: {
            running: {
              startedAt: '2026-09-26T00:00:00Z',
            },
          },
        },
      ],
    },
  };

  beforeEach(async () => {
    _resetOrchestrationProviderRegistry();

    const userData = await createTestUser({ role: 'admin' });
    user = userData.user;

    project = await createTestProject(user._id, {
      name: 'K8s Platform Project',
      key: 'KUBE',
    });

    otherProject = await createTestProject(user._id, {
      name: 'Isolated Other Project',
      key: 'ISOL',
    });

    rawToken = 'k8s-service-account-bearer-token-xyz-12345';
    caCert = '-----BEGIN CERTIFICATE-----\nMIIDXTCCAkWgAwIBAgIJAL...\n-----END CERTIFICATE-----';
    const enc = encrypt(rawToken);

    k8sIntegration = await OrchestrationIntegration.create({
      project: project._id,
      name: 'Production Kubernetes Cluster',
      provider: ORCHESTRATION_PROVIDER.KUBERNETES,
      environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      serverUrl: 'https://k8s.production.internal.domain:6443',
      namespace: 'production',
      caCertificate: caCert,
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
  // 1. Provider Name
  // ============================================================
  describe('1. Provider Name', () => {
    it('returns provider name as kubernetes', () => {
      const provider = new KubernetesProvider();
      expect(provider.getProviderName()).toBe(ORCHESTRATION_PROVIDER.KUBERNETES);
      expect(provider).toBeInstanceOf(BaseOrchestrationProvider);
    });
  });

  // ============================================================
  // 2. Provider Registry Resolution
  // ============================================================
  describe('2. Provider Registry Resolution', () => {
    it('resolves kubernetes provider from registry and verifies contract', () => {
      const provider = getOrchestrationProvider('kubernetes');
      expect(provider).toBeInstanceOf(KubernetesProvider);
      expect(provider.getProviderName()).toBe('kubernetes');
      expect(hasOrchestrationProvider('kubernetes')).toBe(true);
    });
  });

  // ============================================================
  // 3. Unsupported Provider
  // ============================================================
  describe('3. Unsupported Provider', () => {
    it('throws controlled error for unsupported providers', () => {
      expect(() => getOrchestrationProvider('terraform')).toThrow(
        /Unsupported orchestration provider: 'terraform'/
      );
      expect(hasOrchestrationProvider('terraform')).toBe(false);
      expect(() => getOrchestrationProvider('')).toThrow(/Invalid provider name/);
      expect(() => getOrchestrationProvider(null)).toThrow(/Invalid provider name/);
    });
  });

  // ============================================================
  // 4. Successful Kubernetes API Connection
  // ============================================================
  describe('4. Successful Kubernetes API Connection', () => {
    it('returns success when Kubernetes API responds with 200 OK', async () => {
      const provider = new KubernetesProvider();

      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ major: '1', minor: '28', gitVersion: 'v1.28.2' }),
      });

      const result = await provider.testConnection({
        serverUrl: 'https://k8s.production.internal.domain:6443',
        token: rawToken,
        namespace: 'production',
      });

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/connection successful/i);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://k8s.production.internal.domain:6443/api/v1/namespaces/production',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${rawToken}`,
          }),
        })
      );
    });
  });

  // ============================================================
  // 5. Timeout Handling
  // ============================================================
  describe('5. Timeout Handling', () => {
    it('aborts on timeout and returns sanitized failure without leaking credentials', async () => {
      const provider = new KubernetesProvider();

      jest.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const result = await provider.testConnection({
        serverUrl: 'https://k8s.production.internal.domain:6443',
        token: rawToken,
        timeoutMs: 50,
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/timed out/i);
      expect(result.message).not.toContain(rawToken);
    });
  });

  // ============================================================
  // 6. Connection Refusal
  // ============================================================
  describe('6. Connection Refusal', () => {
    it('handles connection errors safely and sanitizes error details', async () => {
      const provider = new KubernetesProvider();

      jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error(`connect ECONNREFUSED 10.0.0.1:6443 with secret ${rawToken}`));

      const result = await provider.testConnection({
        serverUrl: 'https://k8s.production.internal.domain:6443',
        token: rawToken,
      });

      expect(result.success).toBe(false);
      expect(result.message).not.toContain(rawToken);
      expect(result.message).toContain('[REDACTED]');
    });
  });

  // ============================================================
  // 7. 401 Handling
  // ============================================================
  describe('7. 401 Handling', () => {
    it('identifies authentication failure and returns clear message', async () => {
      const provider = new KubernetesProvider();

      jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: 'Unauthorized' }),
      });

      const result = await provider.testConnection({
        serverUrl: 'https://k8s.production.internal.domain:6443',
        token: 'invalid-expired-token',
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/authentication failed/i);
    });
  });

  // ============================================================
  // 8. 403 Handling
  // ============================================================
  describe('8. 403 Handling', () => {
    it('identifies authorization failure and returns clear message', async () => {
      const provider = new KubernetesProvider();

      jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ message: 'User cannot list resource "namespaces" in API group ""' }),
      });

      const result = await provider.testConnection({
        serverUrl: 'https://k8s.production.internal.domain:6443',
        token: rawToken,
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/authorization failed/i);
    });
  });

  // ============================================================
  // 9. 404 Handling
  // ============================================================
  describe('9. 404 Handling', () => {
    it('returns not found message when endpoint or namespace does not exist', async () => {
      const provider = new KubernetesProvider();

      jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: 'namespaces "nonexistent" not found' }),
      });

      const result = await provider.testConnection({
        serverUrl: 'https://k8s.production.internal.domain:6443',
        token: rawToken,
        namespace: 'nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/namespace 'nonexistent' not found/i);
    });
  });

  // ============================================================
  // 10. Malformed Response
  // ============================================================
  describe('10. Malformed Response', () => {
    it('handles non-JSON or corrupted response without crashing', () => {
      const provider = new KubernetesProvider();

      const normalized = provider.normalizeWorkloadStatus('not-valid-json');
      expect(normalized.status).toBe('unknown');
      expect(normalized.workloadName).toBe('');
      expect(normalized.containers).toEqual([]);
    });
  });

  // ============================================================
  // 11. SSRF Rejection
  // ============================================================
  describe('11. SSRF Rejection', () => {
    it('blocks cloud metadata IP address (169.254.169.254)', async () => {
      const provider = new KubernetesProvider();

      await expect(
        provider.fetchWorkloadStatus({
          serverUrl: 'http://169.254.169.254/latest/meta-data',
          token: rawToken,
          workloadName: 'order-service',
        })
      ).rejects.toThrow(
        /SSRF Protection: Access to cloud metadata network addresses is strictly prohibited/
      );
    });

    it('blocks cloud metadata hostname (metadata.google.internal)', async () => {
      const provider = new KubernetesProvider();

      await expect(
        provider.fetchWorkloadStatus({
          serverUrl: 'http://metadata.google.internal',
          token: rawToken,
          workloadName: 'order-service',
        })
      ).rejects.toThrow(
        /SSRF Protection: Access to cloud metadata network addresses is strictly prohibited/
      );
    });
  });

  // ============================================================
  // 12. Private/Loopback Rejection in Production
  // ============================================================
  describe('12. Private/Loopback Rejection in Production', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('rejects localhost and private RFC 1918 IPs in production mode', async () => {
      process.env.NODE_ENV = 'production';
      const provider = new KubernetesProvider();

      await expect(
        provider.fetchWorkloadStatus({
          serverUrl: 'https://192.168.1.100:6443',
          token: rawToken,
          workloadName: 'order-service',
        })
      ).rejects.toThrow(
        /SSRF Protection: Private, loopback, or internal network addresses are not allowed/
      );

      await expect(
        provider.fetchWorkloadStatus({
          serverUrl: 'https://localhost:6443',
          token: rawToken,
          workloadName: 'order-service',
        })
      ).rejects.toThrow(
        /SSRF Protection: Private, loopback, or internal network addresses are not allowed/
      );
    });
  });

  // ============================================================
  // 13. Metadata Address Rejection
  // ============================================================
  describe('13. Metadata Address Rejection', () => {
    it('unconditionally blocks metadata and link-local addresses across all environments', async () => {
      const provider = new KubernetesProvider();

      await expect(
        provider.testConnection({
          serverUrl: 'https://169.254.10.5:6443',
          token: rawToken,
        })
      ).rejects.toThrow(/SSRF Protection/);
    });
  });

  // ============================================================
  // 14. Redirect Rejection
  // ============================================================
  describe('14. Redirect Rejection', () => {
    it('configures redirect: error on fetch requests to prevent SSRF hops', async () => {
      const provider = new KubernetesProvider();

      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleDeployment,
      });

      await provider.fetchWorkloadStatus({
        serverUrl: 'https://k8s.production.internal.domain:6443',
        token: rawToken,
        namespace: 'production',
        workloadType: 'deployment',
        workloadName: 'order-service',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          redirect: 'error',
        })
      );
    });
  });

  // ============================================================
  // 15. Bearer-Token Handling
  // ============================================================
  describe('15. Bearer-Token Handling', () => {
    it('sends decrypted bearer token strictly in Authorization header', async () => {
      const provider = new KubernetesProvider();

      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleDeployment,
      });

      await provider.fetchWorkloadStatus({
        serverUrl: 'https://k8s.production.internal.domain:6443',
        token: rawToken,
        namespace: 'production',
        workloadType: 'deployment',
        workloadName: 'order-service',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://k8s.production.internal.domain:6443/apis/apps/v1/namespaces/production/deployments/order-service',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${rawToken}`,
          }),
        })
      );
    });
  });

  // ============================================================
  // 16. Token Not Exposed in Errors
  // ============================================================
  describe('16. Token Not Exposed in Errors', () => {
    it('sanitizes errors so tokens never leak into thrown exceptions', async () => {
      const provider = new KubernetesProvider();

      jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({
          message: `Cluster internal error mentioning sensitive token ${rawToken}`,
        }),
      });

      let caughtErr = null;
      try {
        await provider.fetchWorkloadStatus({
          serverUrl: 'https://k8s.production.internal.domain:6443',
          token: rawToken,
          workloadName: 'order-service',
        });
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr.message).not.toContain(rawToken);
      expect(caughtErr.message).toContain('[REDACTED]');
    });
  });

  // ============================================================
  // 17. CA Certificate Handling
  // ============================================================
  describe('17. CA Certificate Handling', () => {
    it('attaches HTTPS agent with custom CA certificate without disabling TLS validation', async () => {
      const provider = new KubernetesProvider();

      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleDeployment,
      });

      await provider.fetchWorkloadStatus({
        serverUrl: 'https://k8s.production.internal.domain:6443',
        token: rawToken,
        caCertificate: caCert,
        workloadName: 'order-service',
      });

      expect(fetchSpy).toHaveBeenCalled();
      const callOptions = fetchSpy.mock.calls[0][1];
      expect(callOptions.agent).toBeDefined();
      expect(callOptions.agent.options.rejectUnauthorized).toBe(true);
      expect(callOptions.agent.options.ca).toBe(caCert);

      // Verify CA certificate is not exposed in normalized workload or logs
      const normalized = provider.normalizeWorkloadStatus(sampleDeployment);
      expect(JSON.stringify(normalized)).not.toContain('MIIDXTCCAkWgAwIBAgIJAL');
    });
  });

  // ============================================================
  // 18. Deployment Normalization
  // ============================================================
  describe('18. Deployment Normalization', () => {
    it('normalizes Deployment manifest into platform schema', () => {
      const provider = new KubernetesProvider();
      const normalized = provider.normalizeWorkloadStatus(sampleDeployment);

      expect(normalized).toEqual({
        workloadType: 'deployment',
        workloadName: 'order-service',
        namespace: 'production',
        desiredReplicas: 3,
        readyReplicas: 3,
        availableReplicas: 3,
        updatedReplicas: 3,
        currentRevision: '3',
        observedGeneration: 3,
        generation: 3,
        status: 'healthy',
        message: 'All 3 replicas are ready and available',
        containers: [
          {
            name: 'order-app',
            image: 'order-service:v2.1.0',
            ready: null,
            restartCount: null,
            state: null,
          },
        ],
      });
    });
  });

  // ============================================================
  // 19. StatefulSet Normalization
  // ============================================================
  describe('19. StatefulSet Normalization', () => {
    it('normalizes StatefulSet manifest into platform schema', () => {
      const provider = new KubernetesProvider();
      const normalized = provider.normalizeWorkloadStatus(sampleStatefulSet);

      expect(normalized).toEqual({
        workloadType: 'statefulset',
        workloadName: 'order-db',
        namespace: 'production',
        desiredReplicas: 2,
        readyReplicas: 2,
        availableReplicas: 2,
        updatedReplicas: 2,
        currentRevision: 'order-db-rev-2',
        observedGeneration: 2,
        generation: 2,
        status: 'healthy',
        message: 'All 2 replicas are ready and updated',
        containers: [
          {
            name: 'postgres',
            image: 'postgres:15-alpine',
            ready: null,
            restartCount: null,
            state: null,
          },
        ],
      });
    });
  });

  // ============================================================
  // 20. DaemonSet Normalization
  // ============================================================
  describe('20. DaemonSet Normalization', () => {
    it('normalizes DaemonSet manifest into platform schema', () => {
      const provider = new KubernetesProvider();
      const normalized = provider.normalizeWorkloadStatus(sampleDaemonSet);

      expect(normalized).toEqual({
        workloadType: 'daemonset',
        workloadName: 'log-collector',
        namespace: 'monitoring',
        desiredReplicas: 5,
        readyReplicas: 5,
        availableReplicas: 5,
        updatedReplicas: 5,
        currentRevision: null,
        observedGeneration: 1,
        generation: 1,
        status: 'healthy',
        message: 'All 5 daemon pods are ready',
        containers: [
          {
            name: 'fluentbit',
            image: 'fluent/fluent-bit:2.1',
            ready: null,
            restartCount: null,
            state: null,
          },
        ],
      });
    });
  });

  // ============================================================
  // 21. Pod Normalization
  // ============================================================
  describe('21. Pod Normalization', () => {
    it('normalizes Pod manifest into platform schema with container details', () => {
      const provider = new KubernetesProvider();
      const normalized = provider.normalizeWorkloadStatus(samplePod);

      expect(normalized).toEqual({
        workloadType: 'pod',
        workloadName: 'order-service-789-abc',
        namespace: 'production',
        desiredReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        updatedReplicas: 1,
        currentRevision: null,
        observedGeneration: null,
        generation: null,
        status: 'healthy',
        message: 'Pod is running and all containers are ready',
        containers: [
          {
            name: 'order-app',
            image: 'order-service:v2.1.0',
            ready: true,
            restartCount: 0,
            state: 'running',
          },
        ],
      });
    });
  });

  // ============================================================
  // 22. Healthy Workload Detection
  // ============================================================
  describe('22. Healthy Workload Detection', () => {
    it('detects healthy state for deployments, statefulsets, daemonsets, and pods', () => {
      const provider = new KubernetesProvider();

      expect(provider.normalizeWorkloadStatus(sampleDeployment).status).toBe('healthy');
      expect(provider.normalizeWorkloadStatus(sampleStatefulSet).status).toBe('healthy');
      expect(provider.normalizeWorkloadStatus(sampleDaemonSet).status).toBe('healthy');
      expect(provider.normalizeWorkloadStatus(samplePod).status).toBe('healthy');
    });
  });

  // ============================================================
  // 23. Progressing Workload Detection
  // ============================================================
  describe('23. Progressing Workload Detection', () => {
    it('identifies rollout in progress when replicas have not yet reached desired state', () => {
      const provider = new KubernetesProvider();

      const progressingDeploy = {
        ...sampleDeployment,
        status: {
          ...sampleDeployment.status,
          readyReplicas: 1,
          availableReplicas: 1,
          updatedReplicas: 2,
        },
      };

      const result = provider.normalizeWorkloadStatus(progressingDeploy);
      expect(result.status).toBe('progressing');
      expect(result.message).toMatch(/Rollout in progress/);
    });

    it('identifies progressing state for pending pods', () => {
      const provider = new KubernetesProvider();

      const pendingPod = {
        ...samplePod,
        status: {
          phase: 'Pending',
          containerStatuses: [
            {
              name: 'order-app',
              ready: false,
              state: { waiting: { reason: 'ContainerCreating' } },
            },
          ],
        },
      };

      const result = provider.normalizeWorkloadStatus(pendingPod);
      expect(result.status).toBe('progressing');
    });
  });

  // ============================================================
  // 24. Degraded Workload Detection
  // ============================================================
  describe('24. Degraded Workload Detection', () => {
    it('identifies degraded deployment on ProgressDeadlineExceeded', () => {
      const provider = new KubernetesProvider();

      const degradedDeploy = {
        ...sampleDeployment,
        status: {
          ...sampleDeployment.status,
          conditions: [
            {
              type: 'Progressing',
              status: 'False',
              reason: 'ProgressDeadlineExceeded',
              message: 'ReplicaSet order-service-xxx has timed out progressing.',
            },
          ],
        },
      };

      const result = provider.normalizeWorkloadStatus(degradedDeploy);
      expect(result.status).toBe('degraded');
      expect(result.message).toMatch(/timed out progressing/);
    });

    it('identifies degraded pod on CrashLoopBackOff container state', () => {
      const provider = new KubernetesProvider();

      const crashLoopPod = {
        ...samplePod,
        status: {
          phase: 'Running',
          containerStatuses: [
            {
              name: 'order-app',
              ready: false,
              restartCount: 5,
              state: {
                waiting: {
                  reason: 'CrashLoopBackOff',
                  message: 'Back-off 5m0s restarting failed container',
                },
              },
            },
          ],
        },
      };

      const result = provider.normalizeWorkloadStatus(crashLoopPod);
      expect(result.status).toBe('degraded');
      expect(result.message).toMatch(/CrashLoopBackOff/);
    });
  });

  // ============================================================
  // 25. Unknown Workload Detection
  // ============================================================
  describe('25. Unknown Workload Detection', () => {
    it('handles empty status safely and returns unknown status', () => {
      const provider = new KubernetesProvider();

      const unknownDeploy = {
        kind: 'Deployment',
        metadata: { name: 'sparse-deploy' },
        spec: { replicas: 2 },
      };

      const result = provider.normalizeWorkloadStatus(unknownDeploy);
      expect(result.status).toBe('unknown');
      expect(result.workloadName).toBe('sparse-deploy');
    });
  });

  // ============================================================
  // 26. Generation/ObservedGeneration Drift
  // ============================================================
  describe('26. Generation/ObservedGeneration Drift', () => {
    it('detects drift when observedGeneration does not match metadata generation', () => {
      const provider = new KubernetesProvider();

      const driftedDeploy = {
        ...sampleDeployment,
        metadata: { ...sampleDeployment.metadata, generation: 4 },
        status: { ...sampleDeployment.status, observedGeneration: 3 },
      };

      const drift = provider.detectDrift(driftedDeploy);
      expect(drift.hasDrift).toBe(true);
      expect(drift.reasons).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Observed generation \(3\) does not match generation \(4\)/),
        ])
      );
    });
  });

  // ============================================================
  // 27. Replica Convergence Drift
  // ============================================================
  describe('27. Replica Convergence Drift', () => {
    it('detects drift when availableReplicas is less than desiredReplicas', () => {
      const provider = new KubernetesProvider();

      const replicaDrift = {
        ...sampleDeployment,
        status: {
          ...sampleDeployment.status,
          readyReplicas: 1,
          availableReplicas: 1,
          updatedReplicas: 1,
        },
      };

      const drift = provider.detectDrift(replicaDrift);
      expect(drift.hasDrift).toBe(true);
      expect(drift.reasons).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Ready replicas \(1\) less than desired \(3\)/),
          expect.stringMatching(/Available replicas \(1\) less than desired \(3\)/),
        ])
      );
    });

    it('returns hasDrift: false when workload is fully converged', () => {
      const provider = new KubernetesProvider();
      const drift = provider.detectDrift(sampleDeployment);
      expect(drift.hasDrift).toBe(false);
      expect(drift.reasons).toHaveLength(0);
    });
  });

  // ============================================================
  // 28. No Raw Kubernetes Payload Persistence
  // ============================================================
  describe('28. No Raw Kubernetes Payload Persistence', () => {
    it('ensures normalized workload does not retain raw manifests or sensitive fields', () => {
      const provider = new KubernetesProvider();

      const manifestWithSecret = {
        ...sampleDeployment,
        spec: {
          ...sampleDeployment.spec,
          template: {
            spec: {
              ...sampleDeployment.spec.template.spec,
              containers: [
                {
                  name: 'app',
                  image: 'app:1.0',
                  env: [{ name: 'DB_PASSWORD', value: 'super-secret-db-pass' }],
                },
              ],
            },
          },
        },
      };

      const normalized = provider.normalizeWorkloadStatus(manifestWithSecret);

      const json = JSON.stringify(normalized);
      expect(json).not.toContain('super-secret-db-pass');
      expect(normalized.metadata).toBeUndefined();
      expect(normalized.spec).toBeUndefined();
      expect(normalized.statusText).toBeUndefined();
    });
  });

  // ============================================================
  // 29. Argo CD Provider Regression
  // ============================================================
  describe('29. Argo CD Provider Regression', () => {
    it('ensures Argo CD provider still resolves and functions properly in registry', () => {
      const argoProvider = getOrchestrationProvider('argocd');
      expect(argoProvider).toBeInstanceOf(ArgoCDProvider);
      expect(argoProvider.getProviderName()).toBe('argocd');
      expect(hasOrchestrationProvider('argocd')).toBe(true);

      const normalized = argoProvider.normalizeWorkloadStatus({
        metadata: { name: 'argo-app' },
        status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } },
      });
      expect(normalized.applicationName).toBe('argo-app');
      expect(normalized.syncStatus).toBe('synced');
      expect(normalized.healthStatus).toBe('healthy');
    });
  });

  // ============================================================
  // 30. Project/Integration Isolation
  // ============================================================
  describe('30. Project/Integration Isolation', () => {
    it('operates strictly with authoritative integration configuration without cross-project leakage', async () => {
      const otherEnc = encrypt('other-project-k8s-token');
      const otherK8sIntegration = await OrchestrationIntegration.create({
        project: otherProject._id,
        name: 'Other Project K8s',
        provider: ORCHESTRATION_PROVIDER.KUBERNETES,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        serverUrl: 'https://k8s.other.internal.domain:6443',
        namespace: 'other-prod',
        encryptedToken: otherEnc.ciphertext,
        tokenIv: otherEnc.iv,
        tokenAuthTag: otherEnc.authTag,
        createdBy: user._id,
      });

      // Decrypt token 1
      const doc1 = await OrchestrationIntegration.findById(k8sIntegration._id).select(
        '+encryptedToken +tokenIv +tokenAuthTag'
      );
      const token1 = decrypt({
        ciphertext: doc1.encryptedToken,
        iv: doc1.tokenIv,
        authTag: doc1.tokenAuthTag,
      });

      // Decrypt token 2
      const doc2 = await OrchestrationIntegration.findById(otherK8sIntegration._id).select(
        '+encryptedToken +tokenIv +tokenAuthTag'
      );
      const token2 = decrypt({
        ciphertext: doc2.encryptedToken,
        iv: doc2.tokenIv,
        authTag: doc2.tokenAuthTag,
      });

      expect(token1).toBe(rawToken);
      expect(token2).toBe('other-project-k8s-token');
      expect(doc1.project.toString()).toBe(project._id.toString());
      expect(doc2.project.toString()).toBe(otherProject._id.toString());
      expect(doc1.serverUrl).not.toBe(doc2.serverUrl);
      expect(doc1.namespace).not.toBe(doc2.namespace);
    });
  });
});

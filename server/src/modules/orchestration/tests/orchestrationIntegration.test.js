import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../../app.js';
import OrchestrationIntegration from '../orchestrationIntegration.model.js';
import AuditLog from '../../audit/audit.model.js';
import ProjectMember from '../../projects/projectMember.model.js';
import { createTestUser, createTestProject } from '../../../../tests/helpers.js';
import AuthService from '../../auth/auth.service.js';
import config from '../../../config/index.js';
import { decrypt } from '../../../shared/crypto.js';
import { validateServerUrl } from '../../../shared/urlValidator.js';
import {
  ORCHESTRATION_PROVIDER,
  ORCHESTRATION_STATUS,
  DEPLOYMENT_ENVIRONMENT,
  AUDIT_ACTIONS,
} from '../../../shared/constants.js';

describe('Phase 4 Step 1 — Orchestration Integration Management & Security (Tier A)', () => {
  let ownerUser;
  let devUser;
  let nonMemberUser;
  let ownerAuthCookie;
  let devAuthCookie;
  let nonMemberAuthCookie;
  let project;
  let otherProject;

  beforeEach(async () => {
    // 1. Create owner user & main project
    const ownerData = await createTestUser({ role: 'admin' });
    ownerUser = ownerData.user;
    const ownerToken = AuthService.generateToken(ownerUser);
    ownerAuthCookie = [`${config.jwt.cookieName}=${ownerToken}; Path=/; HttpOnly`];

    project = await createTestProject(ownerUser._id, {
      name: 'Cloud-Native Orchestration Project',
      key: 'CNOP',
    });

    // 2. Create another project for cross-project isolation tests
    otherProject = await createTestProject(ownerUser._id, {
      name: 'Other Isolated Project',
      key: 'OIP',
    });

    // 3. Create developer user
    const devData = await createTestUser({ role: 'developer' });
    devUser = devData.user;
    const devToken = AuthService.generateToken(devUser);
    devAuthCookie = [`${config.jwt.cookieName}=${devToken}; Path=/; HttpOnly`];
    await ProjectMember.create({
      project: project._id,
      user: devUser._id,
      role: 'developer',
    });

    // 4. Create non-member user
    const nonMemberData = await createTestUser({ role: 'developer' });
    nonMemberUser = nonMemberData.user;
    const nonMemberToken = AuthService.generateToken(nonMemberUser);
    nonMemberAuthCookie = [`${config.jwt.cookieName}=${nonMemberToken}; Path=/; HttpOnly`];
  });

  // ==========================================
  // A. Model Validation & Encryption
  // ==========================================
  describe('OrchestrationIntegration Model Validation & Crypto', () => {
    it('creates a valid Kubernetes integration with encrypted credentials', async () => {
      const integration = await OrchestrationIntegration.create({
        project: project._id,
        name: 'Production K8s Cluster',
        provider: ORCHESTRATION_PROVIDER.KUBERNETES,
        environment: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
        serverUrl: 'https://k8s.example.com:6443',
        namespace: 'production',
        caCertificate: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
        encryptedToken: 'abcdef123456',
        tokenIv: '1234567890abcdef',
        tokenAuthTag: 'abcdef1234567890',
        tokenHint: '••••••••1234',
        createdBy: ownerUser._id,
      });

      expect(integration._id).toBeDefined();
      expect(integration.name).toBe('Production K8s Cluster');
      expect(integration.provider).toBe('kubernetes');
      expect(integration.status).toBe(ORCHESTRATION_STATUS.CONNECTED);
      expect(integration.namespace).toBe('production');
      expect(integration.tokenHint).toBe('••••••••1234');
    });

    it('creates a valid Argo CD integration with application scoping', async () => {
      const integration = await OrchestrationIntegration.create({
        project: project._id,
        name: 'Staging ArgoCD',
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        environment: DEPLOYMENT_ENVIRONMENT.STAGING,
        serverUrl: 'https://argocd.example.com',
        applicationName: 'payment-service-staging',
        encryptedToken: 'abcdef123456',
        tokenIv: '1234567890abcdef',
        tokenAuthTag: 'abcdef1234567890',
        tokenHint: '••••••••5678',
        createdBy: ownerUser._id,
      });

      expect(integration._id).toBeDefined();
      expect(integration.provider).toBe('argocd');
      expect(integration.applicationName).toBe('payment-service-staging');
      expect(integration.namespace).toBeNull();
    });

    it('rejects invalid providers outside kubernetes and argocd', async () => {
      const invalid = new OrchestrationIntegration({
        project: project._id,
        name: 'Invalid Provider Cluster',
        provider: 'rancher',
        serverUrl: 'https://rancher.example.com',
        encryptedToken: 'abc',
        tokenIv: 'def',
        tokenAuthTag: 'ghi',
        createdBy: ownerUser._id,
      });

      await expect(invalid.validate()).rejects.toThrow();
    });

    it('enforces compound uniqueness on (project, name)', async () => {
      await OrchestrationIntegration.create({
        project: project._id,
        name: 'Unique Cluster Name',
        provider: ORCHESTRATION_PROVIDER.KUBERNETES,
        serverUrl: 'https://k8s.example.com:6443',
        encryptedToken: 'abc',
        tokenIv: 'def',
        tokenAuthTag: 'ghi',
        createdBy: ownerUser._id,
      });

      const duplicate = new OrchestrationIntegration({
        project: project._id,
        name: 'Unique Cluster Name',
        provider: ORCHESTRATION_PROVIDER.ARGOCD,
        serverUrl: 'https://argocd.example.com',
        encryptedToken: 'xyz',
        tokenIv: 'uvw',
        tokenAuthTag: 'rst',
        createdBy: ownerUser._id,
      });

      await expect(duplicate.save()).rejects.toThrow();
    });

    it('strips encryptedToken, tokenIv, tokenAuthTag, and caCertificate from toJSON and toObject', async () => {
      const integration = await OrchestrationIntegration.create({
        project: project._id,
        name: 'Secret Stripping Test',
        provider: ORCHESTRATION_PROVIDER.KUBERNETES,
        serverUrl: 'https://k8s.example.com',
        caCertificate: 'PEM_RAW_CERTIFICATE',
        encryptedToken: 'CIPHERTEXT_SECRET',
        tokenIv: 'IV_SECRET',
        tokenAuthTag: 'TAG_SECRET',
        tokenHint: '••••••••9999',
        createdBy: ownerUser._id,
      });

      const json = integration.toJSON();
      expect(json.encryptedToken).toBeUndefined();
      expect(json.tokenIv).toBeUndefined();
      expect(json.tokenAuthTag).toBeUndefined();
      expect(json.caCertificate).toBeUndefined();
      expect(json.tokenHint).toBe('••••••••9999');

      const obj = integration.toObject();
      expect(obj.encryptedToken).toBeUndefined();
      expect(obj.tokenIv).toBeUndefined();
      expect(obj.tokenAuthTag).toBeUndefined();
      expect(obj.caCertificate).toBeUndefined();
    });
  });

  // ==========================================
  // B. SSRF & URL Validation
  // ==========================================
  describe('SSRF Protection & URL Validation', () => {
    it('accepts valid public https and http URLs', () => {
      expect(validateServerUrl('https://k8s.cluster.internal.company.com:6443')).toBe(
        'https://k8s.cluster.internal.company.com:6443'
      );
      expect(validateServerUrl('https://argocd.company.com/')).toBe('https://argocd.company.com');
      expect(validateServerUrl('http://my-k8s-api.domain.io:8080/prefix/')).toBe(
        'http://my-k8s-api.domain.io:8080/prefix'
      );
    });

    it('rejects malformed, empty, or non-http protocols', () => {
      expect(() => validateServerUrl('')).toThrow(/required/);
      expect(() => validateServerUrl('not-a-url')).toThrow(/Invalid server URL format/);
      expect(() => validateServerUrl('ftp://k8s.example.com')).toThrow(/Unsupported protocol/);
      expect(() => validateServerUrl('file:///etc/kubernetes/admin.conf')).toThrow(
        /Unsupported protocol/
      );
      expect(() => validateServerUrl('gopher://k8s.example.com')).toThrow(/Unsupported protocol/);
    });

    it('rejects URLs containing embedded credentials', () => {
      expect(() => validateServerUrl('https://admin:password@k8s.example.com')).toThrow(
        /Embedded credentials in server URL are not allowed/
      );
    });

    it('unconditionally blocks cloud metadata addresses in all environments', () => {
      expect(() => validateServerUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
        /cloud metadata network addresses/
      );
      expect(() =>
        validateServerUrl('http://metadata.google.internal/computeMetadata/v1/')
      ).toThrow(/cloud metadata network addresses/);
      expect(() => validateServerUrl('http://169.254.1.1:8080')).toThrow(
        /cloud metadata network addresses/
      );
    });

    it('blocks private IPs and loopback in production mode', () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(() => validateServerUrl('http://127.0.0.1:8080')).toThrow(/SSRF Protection/);
        expect(() => validateServerUrl('http://localhost:8080')).toThrow(/SSRF Protection/);
        expect(() => validateServerUrl('http://10.0.0.1:6443')).toThrow(/SSRF Protection/);
        expect(() => validateServerUrl('https://172.16.5.10:6443')).toThrow(/SSRF Protection/);
        expect(() => validateServerUrl('https://192.168.1.100:6443')).toThrow(/SSRF Protection/);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });
  });

  // ==========================================
  // C. API Endpoints — Create (POST)
  // ==========================================
  describe('POST /api/v1/projects/:projectId/orchestration/integrations', () => {
    it('creates a Kubernetes integration with encrypted token (201)', async () => {
      const payload = {
        name: 'EKS Primary Cluster',
        provider: 'kubernetes',
        environment: 'production',
        serverUrl: 'https://eks-us-east-1.amazonaws.com:6443',
        namespace: 'backend-prod',
        caCertificate: '-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----',
        token: 'eyJhGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.kubernetes-sa-token-string',
      };

      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('EKS Primary Cluster');
      expect(res.body.data.provider).toBe('kubernetes');
      expect(res.body.data.environment).toBe('production');
      expect(res.body.data.namespace).toBe('backend-prod');
      expect(res.body.data.tokenHint).toMatch(/••••••••/);

      // Verify secrets are NOT exposed in API response
      expect(res.body.data.token).toBeUndefined();
      expect(res.body.data.encryptedToken).toBeUndefined();
      expect(res.body.data.tokenIv).toBeUndefined();
      expect(res.body.data.tokenAuthTag).toBeUndefined();
      expect(res.body.data.caCertificate).toBeUndefined();

      // Verify database stored token is properly encrypted and decryptable
      const inDb = await OrchestrationIntegration.findById(res.body.data._id).select(
        '+encryptedToken +tokenIv +tokenAuthTag +caCertificate'
      );
      expect(inDb.encryptedToken).not.toBe(payload.token);
      const decrypted = decrypt({
        ciphertext: inDb.encryptedToken,
        iv: inDb.tokenIv,
        authTag: inDb.tokenAuthTag,
      });
      expect(decrypted).toBe(payload.token);
      expect(inDb.caCertificate).toBe(payload.caCertificate);

      // Verify audit log write
      const audit = await AuditLog.findOne({
        projectId: project._id,
        action: AUDIT_ACTIONS.ORCHESTRATION_INTEGRATION_CREATED,
        entityId: inDb._id,
      });
      expect(audit).not.toBeNull();
      expect(audit.metadata.name).toBe('EKS Primary Cluster');
      expect(audit.metadata.provider).toBe('kubernetes');
      expect(audit.metadata.token).toBeUndefined();
      expect(audit.metadata.encryptedToken).toBeUndefined();
    });

    it('creates an Argo CD integration (201)', async () => {
      const payload = {
        name: 'ArgoCD Production GitOps',
        provider: 'argocd',
        environment: 'production',
        serverUrl: 'https://argocd.company.internal.io',
        applicationName: 'unified-devops-core',
        token: 'argo-cd-api-bearer-token-1234567890',
      };

      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.provider).toBe('argocd');
      expect(res.body.data.applicationName).toBe('unified-devops-core');
      expect(res.body.data.namespace).toBeNull();
    });

    it('rejects invalid provider-specific configuration combinations (400)', async () => {
      // 1. Kubernetes with applicationName
      const invalidK8s = await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Conflicting K8s Integration',
          provider: 'kubernetes',
          serverUrl: 'https://k8s.example.com',
          token: 'k8s-valid-token-12345678',
          applicationName: 'argo-app-should-not-be-here',
        })
        .expect(400);

      expect(invalidK8s.body.message).toMatch(
        /applicationName is not supported for kubernetes provider/
      );

      // 2. Argo CD with namespace
      const invalidArgoNs = await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Conflicting ArgoCD Integration',
          provider: 'argocd',
          serverUrl: 'https://argocd.example.com',
          token: 'argo-valid-token-12345678',
          namespace: 'k8s-namespace-should-not-be-here',
        })
        .expect(400);

      expect(invalidArgoNs.body.message).toMatch(/namespace is not supported for argocd provider/);

      // 3. Argo CD with caCertificate
      const invalidArgoCa = await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Conflicting ArgoCD CA Integration',
          provider: 'argocd',
          serverUrl: 'https://argocd.example.com',
          token: 'argo-valid-token-12345678',
          caCertificate: 'CERT_STRING',
        })
        .expect(400);

      expect(invalidArgoCa.body.message).toMatch(
        /caCertificate is not supported for argocd provider/
      );
    });

    it('rejects duplicate integration name within the same project (409)', async () => {
      const payload = {
        name: 'Shared Name Integration',
        provider: 'kubernetes',
        serverUrl: 'https://k8s-1.example.com',
        token: 'token-one-1234567890',
      };

      await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send(payload)
        .expect(201);

      const dupRes = await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          ...payload,
          serverUrl: 'https://k8s-2.example.com',
        })
        .expect(409);

      expect(dupRes.body.message).toMatch(/already exists in this project/);
    });

    it('allows same integration name in different projects', async () => {
      const payload = {
        name: 'Standard Cluster Name',
        provider: 'kubernetes',
        serverUrl: 'https://k8s.example.com',
        token: 'standard-cluster-token-12345',
      };

      await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send(payload)
        .expect(201);

      await request(app)
        .post(`/api/v1/projects/${otherProject._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send(payload)
        .expect(201);
    });

    it('rejects SSRF cloud metadata URLs (400)', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'SSRF Attack Cluster',
          provider: 'kubernetes',
          serverUrl: 'http://169.254.169.254/latest/meta-data',
          token: 'valid-length-token-1234567890',
        })
        .expect(400);

      expect(res.body.message).toMatch(/SSRF Protection/);
    });

    it('enforces RBAC: developer cannot create integration (403)', async () => {
      await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', devAuthCookie)
        .send({
          name: 'Dev Attempt Cluster',
          provider: 'kubernetes',
          serverUrl: 'https://k8s.example.com',
          token: 'valid-token-string-12345678',
        })
        .expect(403);
    });
  });

  // ==========================================
  // D. API Endpoints — Read (GET)
  // ==========================================
  describe('GET /api/v1/projects/:projectId/orchestration/integrations', () => {
    let k8sIntegration;
    let argoIntegration;

    beforeEach(async () => {
      const res1 = await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'K8s Cluster Prod',
          provider: 'kubernetes',
          environment: 'production',
          serverUrl: 'https://k8s-prod.example.com',
          token: 'token-k8s-prod-1234567890',
        });
      k8sIntegration = res1.body.data;

      const res2 = await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'ArgoCD Staging',
          provider: 'argocd',
          environment: 'staging',
          serverUrl: 'https://argocd-staging.example.com',
          token: 'token-argo-staging-1234567890',
        });
      argoIntegration = res2.body.data;
    });

    it('allows project members (developer) to list integrations', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', devAuthCookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(argoIntegration._id).toBeDefined();
      expect(res.body.data.every((i) => i.encryptedToken === undefined)).toBe(true);
    });

    it('filters integrations by provider and environment', async () => {
      const resK8s = await request(app)
        .get(`/api/v1/projects/${project._id}/orchestration/integrations?provider=kubernetes`)
        .set('Cookie', devAuthCookie)
        .expect(200);

      expect(resK8s.body.data).toHaveLength(1);
      expect(resK8s.body.data[0].name).toBe('K8s Cluster Prod');

      const resStaging = await request(app)
        .get(`/api/v1/projects/${project._id}/orchestration/integrations?environment=staging`)
        .set('Cookie', devAuthCookie)
        .expect(200);

      expect(resStaging.body.data).toHaveLength(1);
      expect(resStaging.body.data[0].name).toBe('ArgoCD Staging');
    });

    it('retrieves single integration by ID with safe formatting', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/orchestration/integrations/${k8sIntegration._id}`)
        .set('Cookie', devAuthCookie)
        .expect(200);

      expect(res.body.data._id).toBe(k8sIntegration._id);
      expect(res.body.data.name).toBe('K8s Cluster Prod');
      expect(res.body.data.encryptedToken).toBeUndefined();
      expect(res.body.data.caCertificate).toBeUndefined();
    });

    it('returns 404 for nonexistent integration ID', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      await request(app)
        .get(`/api/v1/projects/${project._id}/orchestration/integrations/${fakeId}`)
        .set('Cookie', devAuthCookie)
        .expect(404);
    });

    it('enforces project isolation: cannot read integration across projects (404)', async () => {
      await request(app)
        .get(
          `/api/v1/projects/${otherProject._id}/orchestration/integrations/${k8sIntegration._id}`
        )
        .set('Cookie', ownerAuthCookie)
        .expect(404);
    });

    it('rejects unauthorized non-members (403)', async () => {
      await request(app)
        .get(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', nonMemberAuthCookie)
        .expect(403);
    });
  });

  // ==========================================
  // E. API Endpoints — Update (PATCH)
  // ==========================================
  describe('PATCH /api/v1/projects/:projectId/orchestration/integrations/:integrationId', () => {
    let integrationId;

    beforeEach(async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Original Cluster',
          provider: 'kubernetes',
          serverUrl: 'https://k8s-orig.example.com',
          namespace: 'default',
          token: 'original-token-string-12345',
        });
      integrationId = res.body.data._id;
    });

    it('updates integration metadata and re-encrypts token when provided (200)', async () => {
      const updateRes = await request(app)
        .patch(`/api/v1/projects/${project._id}/orchestration/integrations/${integrationId}`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Updated Production Cluster',
          namespace: 'k8s-system',
          token: 'new-rotated-token-1234567890',
        })
        .expect(200);

      expect(updateRes.body.data.name).toBe('Updated Production Cluster');
      expect(updateRes.body.data.namespace).toBe('k8s-system');
      expect(updateRes.body.data.tokenHint).toMatch(/••••••••7890/);

      // Verify database updated and decryptable
      const inDb = await OrchestrationIntegration.findById(integrationId).select(
        '+encryptedToken +tokenIv +tokenAuthTag'
      );
      const decrypted = decrypt({
        ciphertext: inDb.encryptedToken,
        iv: inDb.tokenIv,
        authTag: inDb.tokenAuthTag,
      });
      expect(decrypted).toBe('new-rotated-token-1234567890');

      // Verify audit log for update
      const audit = await AuditLog.findOne({
        projectId: project._id,
        action: AUDIT_ACTIONS.ORCHESTRATION_INTEGRATION_UPDATED,
        entityId: integrationId,
      });
      expect(audit).not.toBeNull();
      expect(audit.metadata.name).toBe('Updated Production Cluster');
    });

    it('rejects invalid provider updates (e.g. applicationName on kubernetes) (400)', async () => {
      await request(app)
        .patch(`/api/v1/projects/${project._id}/orchestration/integrations/${integrationId}`)
        .set('Cookie', ownerAuthCookie)
        .send({
          applicationName: 'should-fail-on-k8s',
        })
        .expect(400);
    });

    it('rejects duplicate name conflict on update (409)', async () => {
      // Create a second integration
      await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Existing Other Cluster',
          provider: 'kubernetes',
          serverUrl: 'https://k8s-other.example.com',
          token: 'token-other-1234567890',
        });

      // Try renaming first integration to match second
      await request(app)
        .patch(`/api/v1/projects/${project._id}/orchestration/integrations/${integrationId}`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Existing Other Cluster',
        })
        .expect(409);
    });

    it('enforces RBAC: developer cannot update integration (403)', async () => {
      await request(app)
        .patch(`/api/v1/projects/${project._id}/orchestration/integrations/${integrationId}`)
        .set('Cookie', devAuthCookie)
        .send({ name: 'Hacked Name' })
        .expect(403);
    });

    it('enforces project isolation: cannot update integration across projects (404)', async () => {
      await request(app)
        .patch(`/api/v1/projects/${otherProject._id}/orchestration/integrations/${integrationId}`)
        .set('Cookie', ownerAuthCookie)
        .send({ name: 'Cross Project Attempt' })
        .expect(404);
    });
  });

  // ==========================================
  // F. API Endpoints — Delete (DELETE)
  // ==========================================
  describe('DELETE /api/v1/projects/:projectId/orchestration/integrations/:integrationId', () => {
    let integrationId;

    beforeEach(async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/orchestration/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Cluster to Delete',
          provider: 'kubernetes',
          serverUrl: 'https://k8s-del.example.com',
          token: 'token-to-delete-1234567890',
        });
      integrationId = res.body.data._id;
    });

    it('enforces RBAC: developer cannot delete integration (403)', async () => {
      await request(app)
        .delete(`/api/v1/projects/${project._id}/orchestration/integrations/${integrationId}`)
        .set('Cookie', devAuthCookie)
        .expect(403);

      expect(await OrchestrationIntegration.findById(integrationId)).not.toBeNull();
    });

    it('enforces project isolation: cannot delete across projects (404)', async () => {
      await request(app)
        .delete(`/api/v1/projects/${otherProject._id}/orchestration/integrations/${integrationId}`)
        .set('Cookie', ownerAuthCookie)
        .expect(404);

      expect(await OrchestrationIntegration.findById(integrationId)).not.toBeNull();
    });

    it('allows owner/admin to delete integration and logs audit event (200)', async () => {
      const res = await request(app)
        .delete(`/api/v1/projects/${project._id}/orchestration/integrations/${integrationId}`)
        .set('Cookie', ownerAuthCookie)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(await OrchestrationIntegration.findById(integrationId)).toBeNull();

      const audit = await AuditLog.findOne({
        projectId: project._id,
        action: AUDIT_ACTIONS.ORCHESTRATION_INTEGRATION_DELETED,
        entityId: integrationId,
      });
      expect(audit).not.toBeNull();
      expect(audit.metadata.name).toBe('Cluster to Delete');
    });
  });
});

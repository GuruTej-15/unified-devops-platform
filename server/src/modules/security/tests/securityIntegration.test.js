import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../../app.js';
import SecurityIntegration from '../securityIntegration.model.js';
import SecurityDelivery from '../securityDelivery.model.js';
import Repository from '../../vcs/repository.model.js';
import PipelineRun from '../../cicd/pipelineRun.model.js';
import ProjectMember from '../../projects/projectMember.model.js';
import { createTestUser, createTestProject } from '../../../../tests/helpers.js';
import AuthService from '../../auth/auth.service.js';
import { verifySecurityToken } from '../security.controller.js';
import { enqueueSecurityScanJob } from '../securityQueue.js';
import config from '../../../config/index.js';

describe('Phase 3 Step 3 — Security Integration & Webhook Ingestion (Tier A)', () => {
  let ownerUser;
  let devUser;
  let nonMemberUser;
  let ownerAuthCookie;
  let devAuthCookie;
  let nonMemberAuthCookie;
  let project;
  let repo;
  let pipelineRun;

  beforeEach(async () => {
    // 1. Create owner user & project
    const ownerData = await createTestUser({ role: 'developer' });
    ownerUser = ownerData.user;
    const ownerToken = AuthService.generateToken(ownerUser);
    ownerAuthCookie = [`${config.jwt.cookieName}=${ownerToken}; Path=/; HttpOnly`];

    project = await createTestProject(ownerUser._id, {
      name: 'Security Governance Project',
      key: 'SGP',
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
      name: 'auth-service',
      owner: 'testowner',
      fullName: 'testowner/auth-service',
      externalId: '123456789',
      htmlUrl: 'https://github.com/testowner/auth-service',
      connectedBy: ownerUser._id,
      encryptedToken: 'cipher',
      tokenIv: 'iv',
      tokenAuthTag: 'tag',
    });

    // 5. Create pipeline run for traceability
    pipelineRun = await PipelineRun.create({
      project: project._id,
      repository: repo._id,
      provider: 'github_actions',
      externalRunId: 'gh-run-500',
      runNumber: 500,
      workflowName: 'Security CI',
      status: 'completed',
      conclusion: 'success',
      commitSha: 'c0ffee1234567890',
      branch: 'main',
    });
  });

  describe('A. SecurityIntegration CRUD API', () => {
    it('creates a new SecurityIntegration with server-generated secret and masked hint', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'GitHub Actions Trivy Ingestion',
          provider: 'trivy',
          repositoryId: repo._id.toString(),
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('GitHub Actions Trivy Ingestion');
      expect(res.body.data.provider).toBe('trivy');
      expect(res.body.data.isActive).toBe(true);
      expect(res.body.data.repository).toBe(repo._id.toString());
      expect(res.body.data.webhookUrl).toBe(`/api/v1/webhooks/security/${res.body.data._id}`);

      // Plaintext secret is returned ONCE
      expect(res.body.data.ingestionSecret).toBeDefined();
      expect(res.body.data.ingestionSecret).toHaveLength(64);

      // Secret hint shows masked characters
      expect(res.body.data.ingestionSecretHint).toMatch(/^••••••••[a-f0-9]{4}$/);

      // Verify DB storage: secret is encrypted and not selected by default
      const inDb = await SecurityIntegration.findById(res.body.data._id);
      expect(inDb.encryptedIngestionSecret).toBeUndefined();
      expect(inDb.ingestionSecretHint).toBe(res.body.data.ingestionSecretHint);
    });

    it('rejects duplicate integration name in the same project with 409 Conflict', async () => {
      await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Unique Integration',
          provider: 'trivy',
        });

      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Unique Integration',
          provider: 'trivy',
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/already exists in this project/i);
    });

    it('allows same integration name in different projects', async () => {
      const otherProject = await createTestProject(ownerUser._id, {
        name: 'Other Project',
        key: 'OTH',
      });

      const res1 = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({ name: 'Shared Name', provider: 'trivy' });
      expect(res1.status).toBe(201);

      const res2 = await request(app)
        .post(`/api/v1/projects/${otherProject._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({ name: 'Shared Name', provider: 'trivy' });
      expect(res2.status).toBe(201);
    });

    it('rejects unsupported provider with 400 Bad Request', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({ name: 'Snyk Ingestion', provider: 'snyk' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid provider/i);
    });

    it('rejects cross-project repository references with 400 Bad Request', async () => {
      const otherProject = await createTestProject(ownerUser._id, {
        name: 'Unrelated Project',
        key: 'UNR',
      });
      const otherRepo = await Repository.create({
        project: otherProject._id,
        name: 'other-repo',
        owner: 'other',
        fullName: 'other/other-repo',
        externalId: '999999',
        htmlUrl: 'https://github.com/other/other-repo',
        connectedBy: ownerUser._id,
        encryptedToken: 'c',
        tokenIv: 'i',
        tokenAuthTag: 't',
      });

      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Cross Repo Attempt',
          provider: 'trivy',
          repositoryId: otherRepo._id.toString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/does not belong to this project/i);
    });

    it('lists integrations without exposing plaintext secrets', async () => {
      const createRes = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({ name: 'List Test Scanner', provider: 'trivy' });

      const listRes = await request(app)
        .get(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', devAuthCookie); // Members can list

      expect(listRes.status).toBe(200);
      expect(listRes.body.success).toBe(true);
      expect(Array.isArray(listRes.body.data)).toBe(true);
      const found = listRes.body.data.find((item) => item._id === createRes.body.data._id);
      expect(found).toBeDefined();
      expect(found.ingestionSecret).toBeUndefined(); // Never exposed in list
      expect(found.ingestionSecretHint).toBeDefined();
    });

    it('updates integration metadata (name, isActive toggle, repositoryId)', async () => {
      const createRes = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({ name: 'Original Name', provider: 'trivy' });

      const patchRes = await request(app)
        .patch(`/api/v1/projects/${project._id}/security/integrations/${createRes.body.data._id}`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Updated Name',
          isActive: false,
          repositoryId: repo._id.toString(),
        });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.name).toBe('Updated Name');
      expect(patchRes.body.data.isActive).toBe(false);
      expect(patchRes.body.data.repository).toBe(repo._id.toString());
    });

    it('rotates ingestion secret and returns new secret ONCE', async () => {
      const createRes = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({ name: 'Rotate Target', provider: 'trivy' });

      const oldSecret = createRes.body.data.ingestionSecret;

      const rotateRes = await request(app)
        .post(
          `/api/v1/projects/${project._id}/security/integrations/${createRes.body.data._id}/rotate`
        )
        .set('Cookie', ownerAuthCookie);

      expect(rotateRes.status).toBe(200);
      const newSecret = rotateRes.body.data.ingestionSecret;
      expect(newSecret).toBeDefined();
      expect(newSecret).toHaveLength(64);
      expect(newSecret).not.toBe(oldSecret);

      // Verify old secret fails authentication via webhook
      const webhookRes = await request(app)
        .post(`/api/v1/webhooks/security/${createRes.body.data._id}`)
        .set('X-Security-Token', oldSecret)
        .send({ SchemaVersion: 2, Results: [] });

      expect(webhookRes.status).toBe(401);
    });

    it('deletes an integration', async () => {
      const createRes = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({ name: 'To Be Deleted', provider: 'trivy' });

      const delRes = await request(app)
        .delete(`/api/v1/projects/${project._id}/security/integrations/${createRes.body.data._id}`)
        .set('Cookie', ownerAuthCookie);

      expect(delRes.status).toBe(200);

      const fetchRes = await request(app)
        .get(`/api/v1/projects/${project._id}/security/integrations/${createRes.body.data._id}`)
        .set('Cookie', ownerAuthCookie);
      expect(fetchRes.status).toBe(404);
    });

    it('enforces RBAC: developer role cannot create or delete integrations (403 Forbidden)', async () => {
      const createRes = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', devAuthCookie) // Developer cannot write integrations
        .send({ name: 'Dev Write Attempt', provider: 'trivy' });

      expect(createRes.status).toBe(403);
    });

    it('enforces RBAC: non-member cannot access integration routes (403 Forbidden)', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', nonMemberAuthCookie);

      expect(res.status).toBe(403);
    });
  });

  describe('B. Constant-Time Secret Verification Utility', () => {
    it('verifies matching tokens correctly', () => {
      expect(verifySecurityToken('secret-token-12345', 'secret-token-12345')).toBe(true);
    });

    it('rejects mismatched tokens', () => {
      expect(verifySecurityToken('secret-token-12345', 'secret-token-wrong')).toBe(false);
    });

    it('rejects tokens of different byte lengths without timing leak', () => {
      expect(verifySecurityToken('short', 'much-longer-expected-token')).toBe(false);
    });

    it('handles null and undefined tokens safely', () => {
      expect(verifySecurityToken(null, 'expected')).toBe(false);
      expect(verifySecurityToken('provided', null)).toBe(false);
      expect(verifySecurityToken(undefined, undefined)).toBe(false);
    });
  });

  describe('C. Security Webhook Report Ingestion API', () => {
    let integration;
    let rawSecret;
    const sampleTrivyPayload = {
      SchemaVersion: 2,
      ArtifactName: 'alpine:3.18.4',
      ArtifactType: 'container_image',
      Results: [
        {
          Target: 'alpine:3.18.4 (alpine 3.18.4)',
          Class: 'os-pkgs',
          Type: 'alpine',
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-2023-44487',
              PkgName: 'libcrypto3',
              InstalledVersion: '3.1.2-r0',
              FixedVersion: '3.1.4-r0',
              Severity: 'CRITICAL',
              Title: 'HTTP/2 Rapid Reset',
            },
          ],
        },
      ],
    };

    beforeEach(async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({
          name: 'Webhook Ingestion Integration',
          provider: 'trivy',
          repositoryId: repo._id.toString(),
        });
      integration = res.body.data;
      rawSecret = res.body.data.ingestionSecret;
    });

    it('accepts valid Trivy scan report with 202 Accepted and returns deliveryId and digest', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', rawSecret)
        .send(sampleTrivyPayload);

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deliveryId).toBeDefined();
      expect(res.body.data.reportDigest).toBeDefined();
      expect(res.body.data.reportDigest).toHaveLength(64);
      expect(res.body.data.duplicate).toBe(false);

      // Verify SecurityDelivery record in database
      const delivery = await SecurityDelivery.findById(res.body.data.deliveryId);
      expect(delivery).toBeDefined();
      expect(delivery.integration.toString()).toBe(integration._id.toString());
      expect(delivery.project.toString()).toBe(project._id.toString());
      expect(delivery.status).toBe('queued');
    });

    it('rejects webhook with missing X-Security-Token header with 401', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .send(sampleTrivyPayload);

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Invalid or missing security token/i);
    });

    it('rejects webhook with invalid X-Security-Token with 401', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', 'completely-invalid-secret-token')
        .send(sampleTrivyPayload);

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Invalid or missing security token/i);
    });

    it('rejects webhook with non-existent integrationId with 401', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .post(`/api/v1/webhooks/security/${fakeId}`)
        .set('X-Security-Token', rawSecret)
        .send(sampleTrivyPayload);

      expect(res.status).toBe(401);
    });

    it('rejects webhook if integration is inactive (isActive: false) with 401', async () => {
      await SecurityIntegration.findByIdAndUpdate(integration._id, { isActive: false });

      const res = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', rawSecret)
        .send(sampleTrivyPayload);

      expect(res.status).toBe(401);
    });

    it('rejects malformed Trivy report (missing SchemaVersion or Results) with 400 Bad Request', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', rawSecret)
        .send({ invalid: 'report-without-schema' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/missing SchemaVersion or Results array/i);
    });

    it('CRITICAL: binds project authoritatively from integration (payload.projectId is ignored)', async () => {
      const otherProject = await createTestProject(ownerUser._id, {
        name: 'Hijack Target Project',
        key: 'HIJ',
      });

      // Attempt to spoof projectId in payload
      const res = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', rawSecret)
        .send({
          ...sampleTrivyPayload,
          projectId: otherProject._id.toString(), // Attacker tries to inject into otherProject
        });

      expect(res.status).toBe(202);

      // Verify delivery is strictly bound to integration.project, NOT the spoofed payload projectId
      const delivery = await SecurityDelivery.findById(res.body.data.deliveryId);
      expect(delivery.project.toString()).toBe(project._id.toString());
      expect(delivery.project.toString()).not.toBe(otherProject._id.toString());
    });

    it('validates optional traceability references (repositoryId, pipelineRunId)', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', rawSecret)
        .send({
          report: sampleTrivyPayload,
          repositoryId: repo._id.toString(),
          pipelineRunId: pipelineRun._id.toString(),
          commitSha: 'c0ffee1234567890',
          branch: 'main',
        });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
    });

    it('rejects cross-project pipelineRunId reference with 400 Bad Request', async () => {
      const otherProject = await createTestProject(ownerUser._id, {
        name: 'Other PR Project',
        key: 'OPP',
      });
      const otherRepo = await Repository.create({
        project: otherProject._id,
        name: 'other-app',
        owner: 'other',
        fullName: 'other/other-app',
        externalId: '888888',
        htmlUrl: 'https://github.com/other/other-app',
        connectedBy: ownerUser._id,
        encryptedToken: 'c',
        tokenIv: 'i',
        tokenAuthTag: 't',
      });
      const otherRun = await PipelineRun.create({
        project: otherProject._id,
        repository: otherRepo._id,
        provider: 'github_actions',
        externalRunId: 'other-run-1',
        runNumber: 1,
        workflowName: 'CI',
        status: 'completed',
        conclusion: 'success',
      });

      const res = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', rawSecret)
        .send({
          report: sampleTrivyPayload,
          pipelineRunId: otherRun._id.toString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/pipeline run does not belong to this project/i);
    });

    it('IDEMPOTENCY: identical report retransmission returns HTTP 202 duplicate: true', async () => {
      // First submission
      const res1 = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', rawSecret)
        .send(sampleTrivyPayload);

      expect(res1.status).toBe(202);
      expect(res1.body.data.duplicate).toBe(false);

      // Replay identical submission
      const res2 = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', rawSecret)
        .send(sampleTrivyPayload);

      expect(res2.status).toBe(202);
      expect(res2.body.data.duplicate).toBe(true);
      expect(res2.body.data.deliveryId).toBe(res1.body.data.deliveryId);
    });

    it('IDEMPOTENCY: same commit and target with CHANGED report content is accepted as new scan', async () => {
      // First scan report
      const res1 = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', rawSecret)
        .send(sampleTrivyPayload);
      expect(res1.status).toBe(202);
      expect(res1.body.data.duplicate).toBe(false);

      // Second scan on same commit/target but with an additional/modified vulnerability
      const modifiedPayload = {
        ...sampleTrivyPayload,
        Results: [
          {
            Target: 'alpine:3.18.4 (alpine 3.18.4)',
            Vulnerabilities: [
              ...sampleTrivyPayload.Results[0].Vulnerabilities,
              {
                VulnerabilityID: 'CVE-2023-5363',
                PkgName: 'libssl3',
                Severity: 'HIGH',
              },
            ],
          },
        ],
      };

      const res2 = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', rawSecret)
        .send(modifiedPayload);

      expect(res2.status).toBe(202);
      expect(res2.body.data.duplicate).toBe(false);
      expect(res2.body.data.deliveryId).not.toBe(res1.body.data.deliveryId);
      expect(res2.body.data.reportDigest).not.toBe(res1.body.data.reportDigest);
    });

    it('IDEMPOTENCY: same report digest on DIFFERENT integrations is allowed independently', async () => {
      // Create second integration in same project
      const int2Res = await request(app)
        .post(`/api/v1/projects/${project._id}/security/integrations`)
        .set('Cookie', ownerAuthCookie)
        .send({ name: 'Second Integration', provider: 'trivy' });

      // Submit identical payload to integration 1
      const res1 = await request(app)
        .post(`/api/v1/webhooks/security/${integration._id}`)
        .set('X-Security-Token', rawSecret)
        .send(sampleTrivyPayload);
      expect(res1.status).toBe(202);
      expect(res1.body.data.duplicate).toBe(false);

      // Submit identical payload to integration 2
      const res2 = await request(app)
        .post(`/api/v1/webhooks/security/${int2Res.body.data._id}`)
        .set('X-Security-Token', int2Res.body.data.ingestionSecret)
        .send(sampleTrivyPayload);
      expect(res2.status).toBe(202);
      expect(res2.body.data.duplicate).toBe(false);
      expect(res2.body.data.deliveryId).not.toBe(res1.body.data.deliveryId);
    });
  });

  describe('D. Queue Producer Unit Tests', () => {
    it('enqueues security scan job with sanitized jobId and correct data', async () => {
      const result = await enqueueSecurityScanJob({
        securityIntegrationId: '65f1234567890abcdef12345',
        projectId: '65f9876543210fedcba54321',
        repositoryId: '65f111111111111111111111',
        pipelineRunId: '65f222222222222222222222',
        commitSha: 'a1b2c3d',
        branch: 'main',
        target: 'alpine:3.18',
        scanType: 'image',
        provider: 'trivy',
        reportDigest: 'digest12345',
        rawPayload: { SchemaVersion: 2, Results: [] },
      });

      expect(result.enqueued).toBe(true);
      expect(result.jobId).toBe('sec-65f1234567890abcdef12345-digest12345');
    });
  });
});

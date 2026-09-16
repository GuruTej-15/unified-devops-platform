import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../../app.js';
import PipelineRun from '../pipelineRun.model.js';
import JenkinsIntegration from '../jenkinsIntegration.model.js';
import Repository from '../../vcs/repository.model.js';
import { createTestUser, createTestProject } from '../../../../tests/helpers.js';
import AuthService from '../../auth/auth.service.js';
import { CI_PROVIDER, PIPELINE_STATUS, PIPELINE_CONCLUSION } from '../../../shared/constants.js';
import { encrypt } from '../../../shared/crypto.js';
import config from '../../../config/index.js';

describe('Phase 2C — PipelineRun Identity & Multi-Provider Webhook Tests', () => {
  let user;
  let authCookie;
  let project;
  let repo;
  let integrationA;
  let integrationB;
  const webhookSecret = 'jenkins-secret-test-token-777';

  beforeEach(async () => {
    await PipelineRun.syncIndexes();

    // 1. Create test user & project with membership
    const testUserData = await createTestUser();
    user = testUserData.user;
    const token = AuthService.generateToken(user);
    authCookie = [`${config.jwt.cookieName}=${token}; Path=/; HttpOnly`];

    project = await createTestProject(user._id, {
      name: 'CI Identity Project',
      key: 'CIP',
    });

    const encryptedToken = encrypt('mock-github-pat');
    repo = await Repository.create({
      project: project._id,
      name: 'payment-service',
      owner: 'testowner',
      fullName: 'testowner/payment-service',
      externalId: '987654321',
      htmlUrl: 'https://github.com/testowner/payment-service',
      connectedBy: user._id,
      encryptedToken: encryptedToken.ciphertext,
      tokenIv: encryptedToken.iv,
      tokenAuthTag: encryptedToken.authTag,
    });

    // Create two Jenkins integrations for the same repository
    const encSecret = encrypt(webhookSecret);
    integrationA = await JenkinsIntegration.create({
      project: project._id,
      repository: repo._id,
      jobName: 'Payment-Build-JobA',
      serverUrl: 'http://jenkins.local:8080',
      encryptedWebhookSecret: encSecret.ciphertext,
      webhookSecretIv: encSecret.iv,
      webhookSecretAuthTag: encSecret.authTag,
    });

    integrationB = await JenkinsIntegration.create({
      project: project._id,
      repository: repo._id,
      jobName: 'Payment-Build-JobB',
      serverUrl: 'http://jenkins.local:8080',
      encryptedWebhookSecret: encSecret.ciphertext,
      webhookSecretIv: encSecret.iv,
      webhookSecretAuthTag: encSecret.authTag,
    });
  });

  // ==============================================================
  // A. PipelineRun Identity Coexistence Tests
  // ==============================================================
  describe('A. PipelineRun Multi-Provider Identity Coexistence', () => {
    it('allows GitHub Actions run and Jenkins build with identical externalRunId to coexist on same repo', async () => {
      const sharedRunId = '4';

      // 1. Create GitHub Actions run #4
      const ghRun = await PipelineRun.upsertWithStatusGuard(
        {
          repository: repo._id,
          provider: CI_PROVIDER.GITHUB_ACTIONS,
          jenkinsIntegration: null,
          externalRunId: sharedRunId,
        },
        {
          project: project._id,
          repository: repo._id,
          provider: CI_PROVIDER.GITHUB_ACTIONS,
          jenkinsIntegration: null,
          externalRunId: sharedRunId,
          runNumber: 4,
          workflowName: 'CI / CD Pipeline',
          status: PIPELINE_STATUS.COMPLETED,
          conclusion: PIPELINE_CONCLUSION.SUCCESS,
        }
      );

      // 2. Create Jenkins Job A build #4
      const jenkinsRun = await PipelineRun.upsertWithStatusGuard(
        {
          repository: repo._id,
          provider: CI_PROVIDER.JENKINS,
          jenkinsIntegration: integrationA._id,
          externalRunId: sharedRunId,
        },
        {
          project: project._id,
          repository: repo._id,
          provider: CI_PROVIDER.JENKINS,
          jenkinsIntegration: integrationA._id,
          externalRunId: sharedRunId,
          runNumber: 4,
          workflowName: 'Payment-Build-JobA',
          status: PIPELINE_STATUS.COMPLETED,
          conclusion: PIPELINE_CONCLUSION.SUCCESS,
        }
      );

      expect(ghRun._id).toBeDefined();
      expect(jenkinsRun._id).toBeDefined();
      expect(ghRun._id.toString()).not.toBe(jenkinsRun._id.toString());
      expect(ghRun.provider).toBe('github_actions');
      expect(jenkinsRun.provider).toBe('jenkins');

      const runs = await PipelineRun.find({ repository: repo._id, externalRunId: sharedRunId });
      expect(runs.length).toBe(2);
    });

    it('allows Jenkins Job A build #4 and Jenkins Job B build #4 to coexist on same repo', async () => {
      const sharedRunId = '4';

      const jenkinsRunA = await PipelineRun.upsertWithStatusGuard(
        {
          repository: repo._id,
          provider: CI_PROVIDER.JENKINS,
          jenkinsIntegration: integrationA._id,
          externalRunId: sharedRunId,
        },
        {
          project: project._id,
          repository: repo._id,
          provider: CI_PROVIDER.JENKINS,
          jenkinsIntegration: integrationA._id,
          externalRunId: sharedRunId,
          runNumber: 4,
          workflowName: 'Payment-Build-JobA',
          status: PIPELINE_STATUS.COMPLETED,
          conclusion: PIPELINE_CONCLUSION.SUCCESS,
        }
      );

      const jenkinsRunB = await PipelineRun.upsertWithStatusGuard(
        {
          repository: repo._id,
          provider: CI_PROVIDER.JENKINS,
          jenkinsIntegration: integrationB._id,
          externalRunId: sharedRunId,
        },
        {
          project: project._id,
          repository: repo._id,
          provider: CI_PROVIDER.JENKINS,
          jenkinsIntegration: integrationB._id,
          externalRunId: sharedRunId,
          runNumber: 4,
          workflowName: 'Payment-Build-JobB',
          status: PIPELINE_STATUS.IN_PROGRESS,
        }
      );

      expect(jenkinsRunA._id).toBeDefined();
      expect(jenkinsRunB._id).toBeDefined();
      expect(jenkinsRunA._id.toString()).not.toBe(jenkinsRunB._id.toString());

      const runs = await PipelineRun.find({ repository: repo._id, externalRunId: sharedRunId });
      expect(runs.length).toBe(2);
    });

    it('idempotently updates without duplicate when delivery for the same Jenkins integration/build is repeated', async () => {
      const filter = {
        repository: repo._id,
        provider: CI_PROVIDER.JENKINS,
        jenkinsIntegration: integrationA._id,
        externalRunId: '4',
      };

      const updated = await PipelineRun.upsertWithStatusGuard(filter, {
        project: project._id,
        repository: repo._id,
        provider: CI_PROVIDER.JENKINS,
        jenkinsIntegration: integrationA._id,
        externalRunId: '4',
        status: PIPELINE_STATUS.COMPLETED,
        conclusion: PIPELINE_CONCLUSION.SUCCESS,
        duration: 25,
      });

      const count = await PipelineRun.countDocuments(filter);
      expect(count).toBe(1);
      expect(updated.duration).toBe(25);
    });
  });

  // ==============================================================
  // B. Route-Based Webhook Authentication & Intake
  // ==============================================================
  describe('B. Route-Based Jenkins Webhook Intake', () => {
    it('rejects request with 401 when X-Jenkins-Token is missing or invalid', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/jenkins/${integrationA._id}`)
        .set('X-Jenkins-Token', 'wrong-token')
        .send({ build: { number: 1, phase: 'STARTED' } });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('rejects request with 401 when integrationId does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .post(`/api/v1/webhooks/jenkins/${fakeId}`)
        .set('X-Jenkins-Token', webhookSecret)
        .send({ build: { number: 1, phase: 'STARTED' } });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('accepts valid Jenkins webhook with 202 and returns deliveryId', async () => {
      const res = await request(app)
        .post(`/api/v1/webhooks/jenkins/${integrationA._id}`)
        .set('X-Jenkins-Token', webhookSecret)
        .send({
          name: 'Payment-Build-JobA',
          build: {
            number: 99,
            phase: 'STARTED',
          },
        });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deliveryId).toContain(integrationA._id.toString());
    });

    it('returns 202 duplicate: true when identical delivery is posted again', async () => {
      const customDeliveryId = 'jenkins-fixed-test-delivery-id-001';
      // First submission
      const res1 = await request(app)
        .post(`/api/v1/webhooks/jenkins/${integrationA._id}`)
        .set('X-Jenkins-Token', webhookSecret)
        .set('X-Jenkins-Delivery', customDeliveryId)
        .send({ build: { number: 101, phase: 'FINALIZED', status: 'SUCCESS' } });

      expect(res1.status).toBe(202);

      // Duplicate submission
      const res2 = await request(app)
        .post(`/api/v1/webhooks/jenkins/${integrationA._id}`)
        .set('X-Jenkins-Token', webhookSecret)
        .set('X-Jenkins-Delivery', customDeliveryId)
        .send({ build: { number: 101, phase: 'FINALIZED', status: 'SUCCESS' } });

      expect(res2.status).toBe(202);
      expect(res2.body.data.duplicate).toBe(true);
    });
  });

  // ==============================================================
  // C. Jenkins Integration CRUD API
  // ==============================================================
  describe('C. Jenkins Integration CRUD API', () => {
    it('creates a new Jenkins integration via POST /api/v1/projects/:projectId/cicd/jenkins', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/cicd/jenkins`)
        .set('Cookie', authCookie)
        .send({
          repositoryId: repo._id,
          jobName: 'New-Jenkins-Job',
          serverUrl: 'http://jenkins.corp:8080',
          username: 'jenkins-admin',
          apiToken: 'test-api-token-12345',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.jobName).toBe('New-Jenkins-Job');
      expect(res.body.data.webhookUrl).toContain('/api/v1/webhooks/jenkins/');
      expect(res.body.data.webhookSecret).toBeDefined();
    });

    it('lists Jenkins integrations with secrets redacted via GET', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/cicd/jenkins`)
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const found = res.body.data.find((item) => item._id === integrationA._id.toString());
      expect(found).toBeDefined();
      expect(found.jobName).toBe('Payment-Build-JobA');
      expect(found.encryptedApiToken).toBeUndefined();
      expect(found.encryptedWebhookSecret).toBeUndefined();
    });

    it('deletes Jenkins integration via DELETE', async () => {
      const res = await request(app)
        .delete(`/api/v1/projects/${project._id}/cicd/jenkins/${integrationA._id}`)
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const check = await JenkinsIntegration.findById(integrationA._id);
      expect(check).toBeNull();
    });
  });
});

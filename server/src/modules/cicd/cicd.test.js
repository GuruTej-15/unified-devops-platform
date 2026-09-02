import request from 'supertest';
import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import app from '../../app.js';
import { createTestUser, createTestProject } from '../../../tests/helpers.js';
import AuthService from '../auth/auth.service.js';
import IssueService from '../issues/issue.service.js';
import Repository from '../vcs/repository.model.js';
import PipelineRun from './pipelineRun.model.js';
import WebhookDelivery from './webhookDelivery.model.js';
import { processWebhookJob } from './queue/ciWorker.js';
import ReconciliationService from './reconciliation.service.js';
import GitHubActionsClient from './github-actions.client.js';
import { encrypt } from '../../shared/crypto.js';
import config from '../../config/index.js';

describe('CI/CD Module — Durable Event Infrastructure & Reconciliation (Phase 2B)', () => {
  const WEBHOOK_SECRET = 'test-github-webhook-secret-12345';
  let ownerUser, otherUser, ownerCookie, otherCookie, project, repository;

  function createSignature(payloadString, secret = WEBHOOK_SECRET) {
    const hmac = crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
    return `sha256=${hmac}`;
  }

  function createAuthCookie(user) {
    const token = AuthService.generateToken(user);
    return [`${config.jwt.cookieName}=${token}; Path=/api/v1; HttpOnly`];
  }

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const res1 = await createTestUser({ email: 'owner_cicd@example.com', username: 'owner_cicd' });
    ownerUser = res1.user;
    ownerCookie = createAuthCookie(ownerUser);

    const res2 = await createTestUser({ email: 'other_cicd@example.com', username: 'other_cicd' });
    otherUser = res2.user;
    otherCookie = createAuthCookie(otherUser);

    project = await createTestProject(ownerUser._id, { key: 'PAY', name: 'Payment Service' });

    await IssueService.createIssue(
      project._id,
      { title: 'Add payment validation', type: 'feature' },
      ownerUser._id
    );

    const encrypted = encrypt('ghp_test_dummy_token_1234');
    repository = await Repository.create({
      project: project._id,
      provider: 'github',
      externalId: '12345678',
      owner: 'acme-corp',
      name: 'payment-service',
      fullName: 'acme-corp/payment-service',
      defaultBranch: 'main',
      htmlUrl: 'https://github.com/acme-corp/payment-service',
      connectedBy: ownerUser._id,
      encryptedToken: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenAuthTag: encrypted.authTag,
      tokenHint: '••••••••1234',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Webhook Security & HMAC-SHA256 Verification', () => {
    it('should reject webhook with 401 when signature is missing', async () => {
      const payload = { workflow_run: { id: 100 }, repository: { id: 12345678 } };

      const res = await request(app)
        .post('/api/v1/webhooks/github')
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'deliv-001')
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('signature');
    });

    it('should reject webhook with 401 when signature is invalid or tampered', async () => {
      const payload = { workflow_run: { id: 100 }, repository: { id: 12345678 } };
      const rawPayload = JSON.stringify(payload);
      const invalidSig = createSignature(rawPayload, 'wrong-secret');

      const res = await request(app)
        .post('/api/v1/webhooks/github')
        .set('X-Hub-Signature-256', invalidSig)
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'deliv-002')
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should reject webhook with 400 when X-GitHub-Delivery header is missing', async () => {
      const payload = { workflow_run: { id: 100 }, repository: { id: 12345678 } };
      const rawPayload = JSON.stringify(payload);
      const sig = createSignature(rawPayload);

      const res = await request(app)
        .post('/api/v1/webhooks/github')
        .set('X-Hub-Signature-256', sig)
        .set('X-GitHub-Event', 'workflow_run')
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('X-GitHub-Delivery');
    });
  });

  describe('Atomic Webhook Delivery Idempotency & Queue Ingestion', () => {
    const webhookPayload = {
      action: 'completed',
      workflow_run: {
        id: 542001,
        run_number: 42,
        workflow_id: 887766,
        name: 'CI Build & Tests',
        path: '.github/workflows/ci.yml',
        head_sha: 'commit_sha_abc123',
        head_branch: 'feature/PAY-101-validation',
        head_commit: {
          id: 'commit_sha_abc123',
          message: 'feat: PAY-101 implement card validation and UNRELATED-999 ignore',
        },
        pull_requests: [
          {
            number: 10,
            title: 'PAY-101: Card validation checks',
            head: { ref: 'feature/PAY-101-validation', sha: 'commit_sha_abc123' },
          },
        ],
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/acme-corp/payment-service/actions/runs/542001',
        run_started_at: '2026-09-01T10:00:00Z',
        updated_at: '2026-09-01T10:02:14Z',
        actor: {
          login: 'octocat',
          avatar_url: 'https://avatars.githubusercontent.com/u/1',
        },
      },
      repository: {
        id: 12345678,
        full_name: 'acme-corp/payment-service',
      },
    };

    it('should atomically claim webhook delivery, record WebhookDelivery, and return 202', async () => {
      const rawPayload = JSON.stringify(webhookPayload);
      const sig = createSignature(rawPayload);

      const res = await request(app)
        .post('/api/v1/webhooks/github')
        .set('X-Hub-Signature-256', sig)
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'delivery-atomic-001')
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deliveryId).toBe('delivery-atomic-001');

      // Verify WebhookDelivery in DB
      const delivery = await WebhookDelivery.findOne({ deliveryId: 'delivery-atomic-001' });
      expect(delivery).toBeDefined();
      expect(delivery.event).toBe('workflow_run');
    });

    it('should safely handle duplicate delivery ID by returning 202 without duplicate queueing', async () => {
      const rawPayload = JSON.stringify(webhookPayload);
      const sig = createSignature(rawPayload);

      // First delivery
      const res1 = await request(app)
        .post('/api/v1/webhooks/github')
        .set('X-Hub-Signature-256', sig)
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'delivery-atomic-dup')
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res1.status).toBe(202);

      // Duplicate delivery (same X-GitHub-Delivery ID)
      const res2 = await request(app)
        .post('/api/v1/webhooks/github')
        .set('X-Hub-Signature-256', sig)
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'delivery-atomic-dup')
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res2.status).toBe(202);
      expect(res2.body.data.duplicate).toBe(true);

      const count = await WebhookDelivery.countDocuments({ deliveryId: 'delivery-atomic-dup' });
      expect(count).toBe(1);
    });
  });

  describe('Worker Processing & Terminal Status Protection', () => {
    it('should process workflow_run event, link issue PAY-101, and persist pipeline run', async () => {
      const delivery = await WebhookDelivery.create({
        deliveryId: 'worker-deliv-001',
        event: 'workflow_run',
        action: 'completed',
        externalRepoId: '12345678',
      });

      const payload = {
        action: 'completed',
        workflow_run: {
          id: 600101,
          run_number: 10,
          workflow_id: 998877,
          name: 'Build and Unit Tests',
          path: '.github/workflows/build.yml',
          head_sha: 'head_sha_123',
          head_branch: 'feature/PAY-101-validation',
          head_commit: {
            id: 'head_sha_123',
            message: 'feat: PAY-101 integrate validation rules',
          },
          pull_requests: [],
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/acme-corp/payment-service/actions/runs/600101',
          run_started_at: '2026-09-01T12:00:00Z',
          updated_at: '2026-09-01T12:02:30Z',
          actor: { login: 'octocat', avatar_url: '' },
        },
        repository: {
          id: 12345678,
          full_name: 'acme-corp/payment-service',
        },
      };

      const result = await processWebhookJob({
        deliveryId: delivery.deliveryId,
        event: 'workflow_run',
        payload,
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.conclusion).toBe('success');

      // Verify PipelineRun in DB
      const run = await PipelineRun.findOne({ externalRunId: '600101' });
      expect(run).toBeDefined();
      expect(run.matchedIssueKeys).toEqual(['PAY-101']);
      expect(run.duration).toBe(150); // 2m 30s

      // Verify WebhookDelivery status updated to 'processed'
      const updatedDelivery = await WebhookDelivery.findOne({ deliveryId: delivery.deliveryId });
      expect(updatedDelivery.status).toBe('processed');
    });

    it('should NOT allow out-of-order in_progress event to regress a completed terminal state', async () => {
      // 1. Create run in 'completed' state
      await PipelineRun.create({
        project: project._id,
        repository: repository._id,
        provider: 'github_actions',
        externalRunId: '700101',
        runNumber: 1,
        workflowName: 'CI',
        commitSha: 'sha_terminal_1',
        branch: 'main',
        status: 'completed',
        conclusion: 'success',
        duration: 120,
      });

      // 2. Simulate late/delayed webhook arriving with 'in_progress' status
      const payload = {
        action: 'in_progress',
        workflow_run: {
          id: 700101,
          run_number: 1,
          workflow_id: 112233,
          name: 'CI',
          head_sha: 'sha_terminal_1',
          head_branch: 'main',
          head_commit: { message: 'PAY-101 late event' },
          pull_requests: [],
          event: 'push',
          status: 'in_progress',
          conclusion: null,
          html_url: '',
          actor: { login: 'octocat' },
        },
        repository: { id: 12345678, full_name: 'acme-corp/payment-service' },
      };

      await processWebhookJob({
        deliveryId: 'deliv-out-of-order',
        event: 'workflow_run',
        payload,
      });

      // 3. Confirm status remained 'completed' and conclusion remained 'success'
      const run = await PipelineRun.findOne({ externalRunId: '700101' });
      expect(run.status).toBe('completed');
      expect(run.conclusion).toBe('success');
      expect(run.duration).toBe(120);
    });
  });

  describe('Reconciliation Engine & Project CI Endpoints', () => {
    it('should reconcile missing runs via ReconciliationService and update state idempotently', async () => {
      const now = new Date();
      jest.spyOn(GitHubActionsClient.prototype, 'getWorkflowRuns').mockResolvedValue([
        {
          id: 888101,
          name: 'Security & Linter',
          workflow_id: 445566,
          head_branch: 'feature/PAY-101-validation',
          head_sha: 'sha_rec_1',
          path: '.github/workflows/lint.yml',
          run_number: 8,
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/acme-corp/payment-service/actions/runs/888101',
          run_started_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
          updated_at: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
          actor: { login: 'dev-user', avatar_url: '' },
          head_commit: { id: 'sha_rec_1', message: 'feat: PAY-101 add linter check' },
          pull_requests: [],
        },
      ]);

      const stats = await ReconciliationService.reconcileRepository(repository._id, {
        lookbackMinutes: 120,
      });

      expect(stats.runsSynced).toBe(1);
      expect(stats.runsCreated).toBe(1);

      const run = await PipelineRun.findOne({ externalRunId: '888101' });
      expect(run).toBeDefined();
      expect(run.workflowName).toBe('Security & Linter');
      expect(run.matchedIssueKeys).toEqual(['PAY-101']);
    });

    it('should allow project admin to trigger project-level reconciliation endpoint (202 Accepted)', async () => {
      jest.spyOn(GitHubActionsClient.prototype, 'getWorkflowRuns').mockResolvedValue([]);

      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/cicd/reconcile`)
        .set('Cookie', ownerCookie)
        .send({ lookbackMinutes: 30 });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('accepted');
    });

    it('should return queue health status via GET /cicd/queue-health', async () => {
      const res = await request(app)
        .get(`/api/v1/projects/${project._id}/cicd/queue-health`)
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('queueName');
      expect(res.body.data).toHaveProperty('mode');
    });

    it('should reject non-members from accessing reconciliation and queue-health (403 Forbidden)', async () => {
      const reconcileRes = await request(app)
        .post(`/api/v1/projects/${project._id}/cicd/reconcile`)
        .set('Cookie', otherCookie)
        .send({});

      expect(reconcileRes.status).toBe(403);

      const healthRes = await request(app)
        .get(`/api/v1/projects/${project._id}/cicd/queue-health`)
        .set('Cookie', otherCookie);

      expect(healthRes.status).toBe(403);
    });
  });
});

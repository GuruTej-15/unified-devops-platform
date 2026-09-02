import request from 'supertest';
import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import app from '../../app.js';
import { createTestUser, createTestProject } from '../../../tests/helpers.js';
import IssueService from '../issues/issue.service.js';
import Repository from '../vcs/repository.model.js';
import PipelineRun from './pipelineRun.model.js';
import Pipeline from './pipeline.model.js';
import GitHubActionsClient from './github-actions.client.js';
import { encrypt } from '../../shared/crypto.js';

describe('CI/CD Module — GitHub Actions Integration (Phase 2A)', () => {
  const WEBHOOK_SECRET = 'test-github-webhook-secret-12345';
  let ownerUser, otherUser, ownerCookie, otherCookie, project, repository;

  function createSignature(payloadString, secret = WEBHOOK_SECRET) {
    const hmac = crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
    return `sha256=${hmac}`;
  }

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const res1 = await createTestUser({ email: 'owner_cicd@example.com', username: 'owner_cicd' });
    ownerUser = res1.user;
    const login1 = await request(app).post('/api/v1/auth/login').send({
      email: ownerUser.email,
      password: res1.rawPassword,
    });
    ownerCookie = login1.headers['set-cookie'];

    const res2 = await createTestUser({ email: 'other_cicd@example.com', username: 'other_cicd' });
    otherUser = res2.user;
    const login2 = await request(app).post('/api/v1/auth/login').send({
      email: otherUser.email,
      password: res2.rawPassword,
    });
    otherCookie = login2.headers['set-cookie'];

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

    it('should accept valid signature with 202 for unknown repository without failing or retrying', async () => {
      const payload = {
        action: 'completed',
        workflow_run: { id: 999, workflow_id: 111, name: 'CI' },
        repository: { id: 99999999, full_name: 'unknown/repo' },
      };
      const rawPayload = JSON.stringify(payload);
      const sig = createSignature(rawPayload);

      const res = await request(app)
        .post('/api/v1/webhooks/github')
        .set('X-Hub-Signature-256', sig)
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'deliv-unknown')
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res.status).toBe(202);
      expect(res.body.message).toContain('not connected');
    });
  });

  describe('Webhook Processing, Idempotency & Issue Traceability', () => {
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

    it('should process workflow_run webhook, link issue PAY-101, and persist pipeline run', async () => {
      const rawPayload = JSON.stringify(webhookPayload);
      const sig = createSignature(rawPayload);

      const res = await request(app)
        .post('/api/v1/webhooks/github')
        .set('X-Hub-Signature-256', sig)
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'delivery-uuid-123')
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);

      // Verify PipelineRun in DB
      const run = await PipelineRun.findOne({ externalRunId: '542001' });
      expect(run).toBeDefined();
      expect(run.workflowName).toBe('CI Build & Tests');
      expect(run.status).toBe('completed');
      expect(run.conclusion).toBe('success');
      expect(run.duration).toBe(134); // 2m 14s in seconds
      expect(run.webhookDeliveryId).toBe('delivery-uuid-123');
      expect(run.providerAction).toBe('completed');

      // Verify Traceability: only PAY-101 is matched, UNRELATED-999 is filtered out
      expect(run.matchedIssueKeys).toEqual(['PAY-101']);

      // Verify Pipeline definition was created
      const pipeline = await Pipeline.findOne({ externalWorkflowId: '887766' });
      expect(pipeline).toBeDefined();
      expect(pipeline.name).toBe('CI Build & Tests');
    });

    it('should enforce idempotency by updating existing run without creating duplicates on repeated delivery', async () => {
      const rawPayload = JSON.stringify(webhookPayload);
      const sig = createSignature(rawPayload);

      // Deliver 3 times
      await request(app)
        .post('/api/v1/webhooks/github')
        .set('X-Hub-Signature-256', sig)
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'delivery-dup-1')
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      await request(app)
        .post('/api/v1/webhooks/github')
        .set('X-Hub-Signature-256', sig)
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'delivery-dup-2')
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      await request(app)
        .post('/api/v1/webhooks/github')
        .set('X-Hub-Signature-256', sig)
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'delivery-dup-3')
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      const count = await PipelineRun.countDocuments({
        repository: repository._id,
        externalRunId: '542001',
      });
      expect(count).toBe(1);
    });
  });

  describe('Project-Scoped CI/CD Endpoints & RBAC Boundaries', () => {
    beforeEach(async () => {
      await PipelineRun.create({
        project: project._id,
        repository: repository._id,
        provider: 'github_actions',
        externalRunId: '888001',
        runNumber: 1,
        workflowName: 'Unit Tests',
        commitSha: 'sha999',
        branch: 'main',
        status: 'completed',
        conclusion: 'success',
        matchedIssueKeys: ['PAY-101'],
      });
    });

    it('should allow project owner to list pipeline runs and get issue-linked runs', async () => {
      const listRes = await request(app)
        .get(`/api/v1/projects/${project._id}/pipeline-runs`)
        .set('Cookie', ownerCookie);

      expect(listRes.status).toBe(200);
      expect(listRes.body.data.length).toBe(1);
      expect(listRes.body.data[0].workflowName).toBe('Unit Tests');

      const issueRunsRes = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/PAY-101/pipeline-runs`)
        .set('Cookie', ownerCookie);

      expect(issueRunsRes.status).toBe(200);
      expect(issueRunsRes.body.data.length).toBe(1);
      expect(issueRunsRes.body.data[0].externalRunId).toBe('888001');

      // Check Activity endpoint includes pipeline runs
      const actRes = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/PAY-101/activity`)
        .set('Cookie', ownerCookie);

      expect(actRes.status).toBe(200);
      expect(actRes.body.data.pipelineRuns.length).toBe(1);
      expect(actRes.body.data.pipelineRuns[0].externalRunId).toBe('888001');
    });

    it('should forbid non-members from accessing project pipeline runs (403 Forbidden)', async () => {
      const listRes = await request(app)
        .get(`/api/v1/projects/${project._id}/pipeline-runs`)
        .set('Cookie', otherCookie);

      expect(listRes.status).toBe(403);

      const issueRunsRes = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/PAY-101/pipeline-runs`)
        .set('Cookie', otherCookie);

      expect(issueRunsRes.status).toBe(403);
    });

    it('should allow manual reconciliation via sync endpoint using mocked GitHubActionsClient', async () => {
      jest.spyOn(GitHubActionsClient.prototype, 'getWorkflowRuns').mockResolvedValue([
        {
          id: 777001,
          name: 'Integration Test Suite',
          workflow_id: 554433,
          head_branch: 'feature/PAY-101-validation',
          head_sha: 'sha_reconcile_1',
          path: '.github/workflows/integration.yml',
          run_number: 15,
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/acme-corp/payment-service/actions/runs/777001',
          run_started_at: '2026-09-01T11:00:00Z',
          updated_at: '2026-09-01T11:03:00Z',
          actor: { login: 'dev-user', avatar_url: '' },
          head_commit: { id: 'sha_reconcile_1', message: 'feat: PAY-101 integration test' },
          pull_requests: [],
        },
      ]);

      const syncRes = await request(app)
        .post(`/api/v1/projects/${project._id}/repositories/${repository._id}/pipelines/sync`)
        .set('Cookie', ownerCookie);

      expect(syncRes.status).toBe(200);
      expect(syncRes.body.data.runsSynced).toBe(1);
      expect(syncRes.body.data.runsCreated).toBe(1);

      const run = await PipelineRun.findOne({ externalRunId: '777001' });
      expect(run).toBeDefined();
      expect(run.workflowName).toBe('Integration Test Suite');
      expect(run.matchedIssueKeys).toEqual(['PAY-101']);
    });
  });
});

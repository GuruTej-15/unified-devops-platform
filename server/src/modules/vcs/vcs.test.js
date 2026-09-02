import request from 'supertest';
import { jest } from '@jest/globals';
import app from '../../app.js';
import { createTestUser, createTestProject } from '../../../tests/helpers.js';
import { encrypt, decrypt, maskToken } from '../../shared/crypto.js';
import { extractIssueKeys } from '../../shared/issueKeyParser.js';
import { ExternalServiceError } from '../../shared/errors.js';
import GitHubClient from './github.client.js';
import IssueService from '../issues/issue.service.js';
import Repository from './repository.model.js';
import Commit from './commit.model.js';
import PullRequest from './pullRequest.model.js';

describe('VCS Module & Utilities', () => {
  describe('Crypto & Parser Utilities', () => {
    it('should encrypt and decrypt secrets with AES-256-GCM', () => {
      const original = 'ghp_secret_personal_access_token_123456789';
      const encrypted = encrypt(original);

      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('authTag');
      expect(encrypted.ciphertext).not.toBe(original);

      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should mask token for safe UI display', () => {
      const masked = maskToken('ghp_abcdef1234567890');
      expect(masked).toBe('••••••••7890');
    });

    it('should extract candidate issue keys from text', () => {
      const text = 'feat(auth): PAY-101 and SEC-204 add payment validation, fixes DEVOPS-99';
      const keys = extractIssueKeys(text);
      expect(keys).toEqual(expect.arrayContaining(['PAY-101', 'SEC-204', 'DEVOPS-99']));
      expect(keys.length).toBe(3);
    });

    it('should handle text with no issue keys', () => {
      const keys = extractIssueKeys('fix typo in readme');
      expect(keys).toEqual([]);
    });
  });

  describe('Mocked GitHub Integration & Traceability Flow', () => {
    let user, cookie, project;

    beforeEach(async () => {
      const res = await createTestUser();
      user = res.user;
      const login = await request(app).post('/api/v1/auth/login').send({
        email: user.email,
        password: res.rawPassword,
      });
      cookie = login.headers['set-cookie'];

      project = await createTestProject(user._id, { key: 'PAY', name: 'Payment Service' });

      // Create two real issues in project PAY
      await IssueService.createIssue(
        project._id,
        {
          title: 'Payment validation',
          type: 'feature',
        },
        user._id
      );

      await IssueService.createIssue(
        project._id,
        {
          title: 'Refund processor bug',
          type: 'bug',
        },
        user._id
      );
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should connect repository with mocked valid token and NEVER expose encrypted PAT in response', async () => {
      // Mock GitHubClient methods
      jest.spyOn(GitHubClient.prototype, 'validateToken').mockResolvedValue({
        valid: true,
        login: 'octocat',
      });

      jest.spyOn(GitHubClient.prototype, 'getRepository').mockResolvedValue({
        externalId: '987654321',
        name: 'payment-service',
        fullName: 'octocat/payment-service',
        description: 'Core payment processing backend',
        htmlUrl: 'https://github.com/octocat/payment-service',
        isPrivate: false,
        defaultBranch: 'main',
        language: 'JavaScript',
        starCount: 42,
      });

      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/repositories`)
        .set('Cookie', cookie)
        .send({
          owner: 'octocat',
          name: 'payment-service',
          token: 'ghp_valid_test_token_1234567890123456',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.fullName).toBe('octocat/payment-service');
      expect(res.body.data.tokenHint).toBe('••••••••3456');

      // CRITICAL SECURITY ASSERTION: PAT secrets are never returned in response body
      expect(res.body.data).not.toHaveProperty('encryptedToken');
      expect(res.body.data).not.toHaveProperty('tokenIv');
      expect(res.body.data).not.toHaveProperty('tokenAuthTag');
      expect(res.body.data).not.toHaveProperty('token');
    });

    it('should synchronize commits, PRs, and live branches with multi-step validated traceability', async () => {
      // Setup connected repo in DB
      const encrypted = encrypt('ghp_mock_token_for_sync_test_9999');
      const repo = await Repository.create({
        project: project._id,
        provider: 'github',
        externalId: '987654321',
        owner: 'octocat',
        name: 'payment-service',
        fullName: 'octocat/payment-service',
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/octocat/payment-service',
        connectedBy: user._id,
        encryptedToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenAuthTag: encrypted.authTag,
        tokenHint: '••••••••9999',
      });

      // Mock GitHubClient commits response
      jest.spyOn(GitHubClient.prototype, 'getCommits').mockResolvedValue({
        commits: [
          {
            sha: 'commit_sha_101',
            message: 'feat(pay): PAY-101 implement card validation and NONEXISTENT-999 ignore',
            authorName: 'Alex Dev',
            authorEmail: 'alex@example.com',
            authorAvatar: 'https://avatars.githubusercontent.com/u/1',
            authoredAt: new Date('2026-09-01T10:00:00Z'),
            url: 'https://github.com/octocat/payment-service/commit/commit_sha_101',
          },
          {
            sha: 'commit_sha_102',
            message: 'fix(pay): PAY-102 fix calculation error',
            authorName: 'Sam QA',
            authorEmail: 'sam@example.com',
            authorAvatar: 'https://avatars.githubusercontent.com/u/2',
            authoredAt: new Date('2026-09-01T11:00:00Z'),
            url: 'https://github.com/octocat/payment-service/commit/commit_sha_102',
          },
        ],
        hasNextPage: false,
        endCursor: null,
      });

      // Mock GitHubClient PRs response
      jest.spyOn(GitHubClient.prototype, 'getPullRequests').mockResolvedValue({
        pullRequests: [
          {
            number: 42,
            title: 'feat: PAY-101 Payment gateway integration',
            body: 'Closes PAY-101 and fixes edge cases',
            state: 'open',
            url: 'https://github.com/octocat/payment-service/pull/42',
            authorLogin: 'octocat',
            authorAvatar: 'https://avatars.githubusercontent.com/u/1',
            sourceBranch: 'feature/PAY-101-validation',
            targetBranch: 'main',
            createdAt: new Date('2026-09-01T10:30:00Z'),
            updatedAt: new Date('2026-09-01T11:00:00Z'),
          },
        ],
        hasNextPage: false,
        endCursor: null,
      });

      // Mock GitHubClient branches response
      jest.spyOn(GitHubClient.prototype, 'getBranches').mockResolvedValue([
        {
          name: 'main',
          lastCommit: {
            sha: 'commit_sha_102',
            message: 'fix(pay): PAY-102 fix calculation error',
            date: new Date('2026-09-01T11:00:00Z'),
            author: 'Sam QA',
          },
        },
        {
          name: 'feature/PAY-101-validation',
          lastCommit: {
            sha: 'commit_sha_101',
            message: 'feat(pay): PAY-101 implement card validation',
            date: new Date('2026-09-01T10:00:00Z'),
            author: 'Alex Dev',
          },
        },
      ]);

      // 1. Trigger Sync
      const syncRes = await request(app)
        .post(`/api/v1/projects/${project._id}/repositories/${repo._id}/sync`)
        .set('Cookie', cookie);

      expect(syncRes.status).toBe(200);
      expect(syncRes.body.success).toBe(true);
      expect(syncRes.body.data.commitsAdded).toBe(2);
      expect(syncRes.body.data.prsAdded).toBe(1);

      // Verify Commit Traceability in DB
      const syncedCommit101 = await Commit.findOne({ sha: 'commit_sha_101' });
      expect(syncedCommit101).toBeDefined();
      // Should match ONLY the real PAY-101, and exclude NONEXISTENT-999
      expect(syncedCommit101.matchedIssueKeys).toEqual(['PAY-101']);

      const syncedPR42 = await PullRequest.findOne({ number: 42 });
      expect(syncedPR42).toBeDefined();
      expect(syncedPR42.matchedIssueKeys).toEqual(['PAY-101']);

      // 2. Test Duplicate Sync Prevention (upsert without duplication)
      const resyncRes = await request(app)
        .post(`/api/v1/projects/${project._id}/repositories/${repo._id}/sync`)
        .set('Cookie', cookie);

      expect(resyncRes.status).toBe(200);
      expect(resyncRes.body.data.commitsAdded).toBe(0);
      expect(resyncRes.body.data.commitsUpdated).toBe(2);
      expect(await Commit.countDocuments({ repository: repo._id })).toBe(2);
      expect(await PullRequest.countDocuments({ repository: repo._id })).toBe(1);

      // 3. Test Live Branches endpoint
      const branchRes = await request(app)
        .get(`/api/v1/projects/${project._id}/repositories/${repo._id}/branches`)
        .set('Cookie', cookie);

      expect(branchRes.status).toBe(200);
      expect(branchRes.body.data.length).toBe(2);
      expect(branchRes.body.data[0].name).toBe('main');

      // 4. Test Activity Endpoint on Issue PAY-101
      const activityRes = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/PAY-101/activity`)
        .set('Cookie', cookie);

      expect(activityRes.status).toBe(200);
      expect(activityRes.body.data.commits.length).toBe(1);
      expect(activityRes.body.data.commits[0].sha).toBe('commit_sha_101');
      expect(activityRes.body.data.pullRequests.length).toBe(1);
      expect(activityRes.body.data.pullRequests[0].number).toBe(42);
      expect(activityRes.body.data.branches).toContain('feature/PAY-101-validation');
    });

    it('should handle rate limit and external errors gracefully without crashing', async () => {
      const encrypted = encrypt('ghp_mock_token_for_sync_test_9999');
      const repo = await Repository.create({
        project: project._id,
        provider: 'github',
        externalId: '987654321',
        owner: 'octocat',
        name: 'payment-service',
        fullName: 'octocat/payment-service',
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/octocat/payment-service',
        connectedBy: user._id,
        encryptedToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenAuthTag: encrypted.authTag,
        tokenHint: '••••••••9999',
      });

      // Mock rate limit error from GitHub client
      jest
        .spyOn(GitHubClient.prototype, 'getCommits')
        .mockRejectedValue(
          new ExternalServiceError(
            'GitHub',
            'Failed to fetch commits: GitHub API rate limit exceeded'
          )
        );

      const res = await request(app)
        .post(`/api/v1/projects/${project._id}/repositories/${repo._id}/sync`)
        .set('Cookie', cookie);

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('GitHub');

      // Check repository status in database was updated to 'failed' with error reason
      const updatedRepo = await Repository.findById(repo._id);
      expect(updatedRepo.connectionStatus).toBe('failed');
      expect(updatedRepo.lastSyncStatus).toBe('failed');
      expect(updatedRepo.lastSyncError).toContain('rate limit');
    });
  });
});

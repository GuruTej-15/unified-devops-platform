import request from 'supertest';
import app from '../../app.js';
import { createTestUser, createTestProject } from '../../../tests/helpers.js';
import Commit from '../vcs/commit.model.js';
import Repository from '../vcs/repository.model.js';

describe('Issues Module', () => {
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
  });

  describe('Issue Key Generation & Atomic Counter', () => {
    it('should generate sequential keys starting strictly at PAY-101, PAY-102, PAY-103', async () => {
      const res1 = await request(app)
        .post(`/api/v1/projects/${project._id}/issues`)
        .set('Cookie', cookie)
        .send({ title: 'Issue 1' });
      expect(res1.status).toBe(201);
      expect(res1.body.data.issueKey).toBe('PAY-101');
      expect(res1.body.data.issueNumber).toBe(101);

      const res2 = await request(app)
        .post(`/api/v1/projects/${project._id}/issues`)
        .set('Cookie', cookie)
        .send({ title: 'Issue 2' });
      expect(res2.status).toBe(201);
      expect(res2.body.data.issueKey).toBe('PAY-102');
      expect(res2.body.data.issueNumber).toBe(102);

      const res3 = await request(app)
        .post(`/api/v1/projects/${project._id}/issues`)
        .set('Cookie', cookie)
        .send({ title: 'Issue 3' });
      expect(res3.status).toBe(201);
      expect(res3.body.data.issueKey).toBe('PAY-103');
      expect(res3.body.data.issueNumber).toBe(103);
    });

    it('should handle concurrent issue creation without collisions or duplicate keys', async () => {
      const tasks = Array.from({ length: 5 }, (_, i) =>
        request(app)
          .post(`/api/v1/projects/${project._id}/issues`)
          .set('Cookie', cookie)
          .send({ title: `Concurrent Task ${i + 1}` })
      );

      const results = await Promise.all(tasks);
      results.forEach((res) => {
        expect(res.status).toBe(201);
      });

      const keys = results.map((r) => r.body.data.issueKey);
      const uniqueKeys = new Set(keys);

      // Verify all keys are unique
      expect(uniqueKeys.size).toBe(5);

      // Verify keys span PAY-101 through PAY-105
      const expectedKeys = ['PAY-101', 'PAY-102', 'PAY-103', 'PAY-104', 'PAY-105'];
      expect(keys.sort()).toEqual(expectedKeys);
    });
  });

  describe('GET & PUT /api/v1/projects/:projectId/issues/:issueKey', () => {
    it('should retrieve and update an issue by key', async () => {
      const createRes = await request(app)
        .post(`/api/v1/projects/${project._id}/issues`)
        .set('Cookie', cookie)
        .send({ title: 'Task to update', priority: 'low' });

      const issueKey = createRes.body.data.issueKey;

      const getRes = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/${issueKey}`)
        .set('Cookie', cookie);

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.issueKey).toBe(issueKey);

      const updateRes = await request(app)
        .put(`/api/v1/projects/${project._id}/issues/${issueKey}`)
        .set('Cookie', cookie)
        .send({ status: 'in_progress', priority: 'high' });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.status).toBe('in_progress');
      expect(updateRes.body.data.priority).toBe('high');
    });
  });

  describe('Comments & Activity', () => {
    it('should add comment, retrieve paginated comments, and return activity links', async () => {
      const createRes = await request(app)
        .post(`/api/v1/projects/${project._id}/issues`)
        .set('Cookie', cookie)
        .send({ title: 'Traceable task' });

      const issueKey = createRes.body.data.issueKey;

      // Add comment
      const commentRes = await request(app)
        .post(`/api/v1/projects/${project._id}/issues/${issueKey}/comments`)
        .set('Cookie', cookie)
        .send({ body: 'Working on implementation right now' });

      expect(commentRes.status).toBe(201);
      expect(commentRes.body.data.body).toBe('Working on implementation right now');

      // Get comments list
      const getCommentsRes = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/${issueKey}/comments`)
        .set('Cookie', cookie);

      expect(getCommentsRes.status).toBe(200);
      expect(getCommentsRes.body.data.length).toBe(1);

      // Create a mock repository and commit that references this issue key
      const repo = await Repository.create({
        project: project._id,
        provider: 'github',
        externalId: '123456',
        owner: 'acme',
        name: 'payment-service',
        fullName: 'acme/payment-service',
        htmlUrl: 'https://github.com/acme/payment-service',
        connectedBy: user._id,
        encryptedToken: 'dummy',
        tokenIv: 'dummy',
        tokenAuthTag: 'dummy',
      });

      await Commit.create({
        repository: repo._id,
        project: project._id,
        sha: 'abc123456789',
        message: `${issueKey}: Implemented payment validation logic`,
        authorName: 'Developer',
        authoredAt: new Date(),
        matchedIssueKeys: [issueKey],
      });

      // Query activity
      const activityRes = await request(app)
        .get(`/api/v1/projects/${project._id}/issues/${issueKey}/activity`)
        .set('Cookie', cookie);

      expect(activityRes.status).toBe(200);
      expect(activityRes.body.data.commits.length).toBe(1);
      expect(activityRes.body.data.commits[0].sha).toBe('abc123456789');
    });
  });
});

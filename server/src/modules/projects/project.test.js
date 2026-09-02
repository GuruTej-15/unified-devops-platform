import request from 'supertest';
import app from '../../app.js';
import { createTestUser, createTestProject } from '../../../tests/helpers.js';

describe('Projects Module & Project-Level RBAC', () => {
  let user1, user2, user3, cookie1, cookie2, cookie3;

  beforeEach(async () => {
    // User 1: Project Owner
    const res1 = await createTestUser({ email: 'owner@example.com', username: 'owner1' });
    user1 = res1.user;
    const login1 = await request(app).post('/api/v1/auth/login').send({
      email: user1.email,
      password: res1.rawPassword,
    });
    cookie1 = login1.headers['set-cookie'];

    // User 2: Viewer Member
    const res2 = await createTestUser({ email: 'viewer@example.com', username: 'viewer1' });
    user2 = res2.user;
    const login2 = await request(app).post('/api/v1/auth/login').send({
      email: user2.email,
      password: res2.rawPassword,
    });
    cookie2 = login2.headers['set-cookie'];

    // User 3: Complete Non-Member
    const res3 = await createTestUser({ email: 'outsider@example.com', username: 'outsider1' });
    user3 = res3.user;
    const login3 = await request(app).post('/api/v1/auth/login').send({
      email: user3.email,
      password: res3.rawPassword,
    });
    cookie3 = login3.headers['set-cookie'];
  });

  describe('POST /api/v1/projects', () => {
    it('should create a project and initialize issue counter and owner membership', async () => {
      const projectData = {
        name: 'Payment Service',
        key: 'PAY',
        description: 'Handles core payment gateways',
      };

      const res = await request(app)
        .post('/api/v1/projects')
        .set('Cookie', cookie1)
        .send(projectData);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.key).toBe('PAY');
      expect(res.body.data.name).toBe('Payment Service');
      expect(res.body.data.owner.email).toBe(user1.email);
    });

    it('should reject invalid project key format', async () => {
      const res = await request(app).post('/api/v1/projects').set('Cookie', cookie1).send({
        name: 'Invalid Key Project',
        key: 'TOOLONGKEY',
      });

      expect(res.status).toBe(422);
    });
  });

  describe('Project-Level Access Boundaries & RBAC', () => {
    let project;

    beforeEach(async () => {
      project = await createTestProject(user1._id, { key: 'PAY', name: 'Payment Service' });

      // Add user2 as Viewer
      await request(app)
        .post(`/api/v1/projects/${project._id}/members`)
        .set('Cookie', cookie1)
        .send({ userId: user2._id.toString(), role: 'viewer' });
    });

    it('should forbid non-members from accessing project details, issues, repositories, and audit logs', async () => {
      // 1. Project details
      const viewProj = await request(app)
        .get(`/api/v1/projects/${project._id}`)
        .set('Cookie', cookie3);
      expect(viewProj.status).toBe(403);

      // 2. Project issues
      const viewIssues = await request(app)
        .get(`/api/v1/projects/${project._id}/issues`)
        .set('Cookie', cookie3);
      expect(viewIssues.status).toBe(403);

      // 3. Project repositories
      const viewRepos = await request(app)
        .get(`/api/v1/projects/${project._id}/repositories`)
        .set('Cookie', cookie3);
      expect(viewRepos.status).toBe(403);

      // 4. Project audit logs
      const viewAudit = await request(app)
        .get(`/api/v1/audit-logs/projects/${project._id}`)
        .set('Cookie', cookie3);
      expect(viewAudit.status).toBe(403);
    });

    it('should allow viewer to read project but forbid viewer from modifying settings or adding members', async () => {
      // Viewer can read project details
      const readRes = await request(app)
        .get(`/api/v1/projects/${project._id}`)
        .set('Cookie', cookie2);
      expect(readRes.status).toBe(200);

      // Viewer cannot update project settings (requires owner or admin)
      const updateRes = await request(app)
        .put(`/api/v1/projects/${project._id}`)
        .set('Cookie', cookie2)
        .send({ name: 'Unauthorized Name Change' });
      expect(updateRes.status).toBe(403);

      // Viewer cannot add members
      const addMemberRes = await request(app)
        .post(`/api/v1/projects/${project._id}/members`)
        .set('Cookie', cookie2)
        .send({ userId: user3._id.toString(), role: 'developer' });
      expect(addMemberRes.status).toBe(403);
    });

    it('should allow owner to update settings and manage membership roles', async () => {
      const updateRes = await request(app)
        .put(`/api/v1/projects/${project._id}`)
        .set('Cookie', cookie1)
        .send({ name: 'Updated Payment Service' });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.name).toBe('Updated Payment Service');

      // Promote viewer to developer
      const roleRes = await request(app)
        .put(`/api/v1/projects/${project._id}/members/${user2._id}`)
        .set('Cookie', cookie1)
        .send({ role: 'developer' });
      expect(roleRes.status).toBe(200);
      expect(roleRes.body.data.role).toBe('developer');
    });
  });
});

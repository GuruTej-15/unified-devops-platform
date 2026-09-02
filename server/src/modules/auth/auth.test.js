import request from 'supertest';
import app from '../../app.js';
import { createTestUser } from '../../../tests/helpers.js';
import AuthService from './auth.service.js';
import User from '../users/user.model.js';

describe('Auth Module & Security', () => {
  describe('POST /api/v1/auth/register', () => {
    it('should register a new user with bcrypt password hashing and set HttpOnly cookie', async () => {
      const userData = {
        email: 'dev@example.com',
        username: 'devuser',
        password: 'Password123!',
        firstName: 'Alex',
        lastName: 'Dev',
        role: 'developer',
      };

      const res = await request(app).post('/api/v1/auth/register').send(userData);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('_id');
      expect(res.body.data.email).toBe(userData.email);
      expect(res.body.data).not.toHaveProperty('password');
      expect(res.headers['set-cookie']).toBeDefined();

      // Verify bcrypt hash at rest in database
      const dbUser = await User.findById(res.body.data._id).select('+password');
      expect(dbUser.password).not.toBe(userData.password);
      expect(dbUser.password).toMatch(/^\$2[ab]\$12\$/); // bcrypt 12 rounds prefix
    });

    it('should reject duplicate email', async () => {
      await createTestUser({ email: 'duplicate@example.com', username: 'user1' });

      const res = await request(app).post('/api/v1/auth/register').send({
        email: 'duplicate@example.com',
        username: 'user2',
        password: 'Password123!',
        firstName: 'Another',
        lastName: 'User',
      });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('should reject weak password', async () => {
      const res = await request(app).post('/api/v1/auth/register').send({
        email: 'weak@example.com',
        username: 'weakuser',
        password: '123',
        firstName: 'Weak',
        lastName: 'Password',
      });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('should login with valid credentials', async () => {
      const { user, rawPassword } = await createTestUser();

      const res = await request(app).post('/api/v1/auth/login').send({
        email: user.email,
        password: rawPassword,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.email).toBe(user.email);
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('should reject invalid password', async () => {
      const { user } = await createTestUser();

      const res = await request(app).post('/api/v1/auth/login').send({
        email: user.email,
        password: 'WrongPassword999!',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/v1/auth/me & Dual Authentication Support', () => {
    it('should authenticate via HttpOnly cookie', async () => {
      const { user, rawPassword } = await createTestUser();

      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: rawPassword });

      const cookie = loginRes.headers['set-cookie'];

      const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body.data._id).toBe(user._id.toString());
    });

    it('should authenticate via Authorization Bearer header for CLI/API clients', async () => {
      const { user } = await createTestUser();
      const token = AuthService.generateToken(user);

      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data._id).toBe(user._id.toString());
    });

    it('should reject unauthenticated request', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });

    it('should reject invalid / malformed JWT token', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer invalid.token.payload');

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid token');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('should clear the auth cookie', async () => {
      const { user, rawPassword } = await createTestUser();
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: rawPassword });

      const cookie = loginRes.headers['set-cookie'];

      const res = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});

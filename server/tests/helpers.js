import request from 'supertest';
import ProjectService from '../src/modules/projects/project.service.js';
import AuthService from '../src/modules/auth/auth.service.js';

export const createTestUser = async (overrides = {}) => {
  const defaultUser = {
    email: `test-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`,
    username: `user_${Date.now().toString().slice(-4)}_${Math.random().toString(36).substring(7)}`,
    password: 'Password123!',
    firstName: 'Test',
    lastName: 'User',
    role: 'developer',
  };

  const userData = { ...defaultUser, ...overrides };
  const user = await AuthService.register(userData);
  return { user, rawPassword: userData.password };
};

export const getAuthCookie = async (app, email, password) => {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });

  const cookies = res.headers['set-cookie'];
  return {
    cookie: cookies,
    body: res.body,
    token: AuthService.generateToken(res.body.data),
  };
};

export const createTestProject = async (userId, overrides = {}) => {
  const defaultProject = {
    name: 'Test Project',
    key: `TP${Math.floor(10 + Math.random() * 89)}`,
    description: 'A test project',
  };
  return ProjectService.createProject({ ...defaultProject, ...overrides }, userId);
};

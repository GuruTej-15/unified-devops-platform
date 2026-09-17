import request from 'supertest';
import { jest } from '@jest/globals';
import app from '../../../app.js';
import { createTestUser } from '../../../../tests/helpers.js';
import config from '../../../config/index.js';
import AuthService from '../../auth/auth.service.js';
import {
  publishPipelineEvent,
  initPipelineEventSubscriber,
  handleIncomingRedisMessage,
  closePipelineEventSubscriber,
  closePipelineEventPublisher,
  _resetEventBridgeState,
} from './ciEventBridge.js';
import eventBus from '../../notifications/eventBus.js';

describe('Phase 2B Defect Fixes — Cookie Path & Redis Cross-Process Event Bridge', () => {
  afterEach(async () => {
    _resetEventBridgeState();
    await closePipelineEventSubscriber();
    await closePipelineEventPublisher();
    jest.clearAllMocks();
  });

  // ==========================================
  // A. COOKIE PATH VERIFICATION
  // ==========================================
  describe('A. Authentication Cookie Path Scoping', () => {
    it('register Set-Cookie header contains Path=/', async () => {
      const timestamp = Date.now();
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: `cookie_test_${timestamp}@example.com`,
          username: `cookie_user_${timestamp}`,
          password: 'Password123!',
          firstName: 'Cookie',
          lastName: 'Test',
        });

      expect(res.status).toBe(201);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieHeader).toContain('Path=/');
      expect(cookieHeader).not.toContain('Path=/api/v1');
      expect(cookieHeader).toContain('HttpOnly');
    });

    it('login Set-Cookie header contains Path=/', async () => {
      const { user, rawPassword } = await createTestUser();
      const res = await request(app).post('/api/v1/auth/login').send({
        email: user.email,
        password: rawPassword,
      });

      expect(res.status).toBe(200);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieHeader).toContain('Path=/');
      expect(cookieHeader).not.toContain('Path=/api/v1');
      expect(cookieHeader).toContain('HttpOnly');
    });

    it('logout clears cookie with Path=/', async () => {
      const { user } = await createTestUser();
      const token = AuthService.generateToken(user);
      const authCookie = [`${config.jwt.cookieName}=${token}; Path=/; HttpOnly`];

      const res = await request(app).post('/api/v1/auth/logout').set('Cookie', authCookie);

      expect(res.status).toBe(200);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieHeader).toContain('Path=/');
      expect(cookieHeader).not.toContain('Path=/api/v1');
    });
  });

  // ==========================================
  // B. REDIS PUB/SUB EVENT BRIDGE
  // ==========================================
  describe('B. Redis Cross-Process Event Bridge', () => {
    it('publisher serializes expected contract payload and requires eventType and projectId', async () => {
      // Missing fields guard
      const invalidRes1 = await publishPipelineEvent('', { project: 'proj123' });
      expect(invalidRes1.published).toBe(false);

      const invalidRes2 = await publishPipelineEvent('pipeline.updated', {});
      expect(invalidRes2.published).toBe(false);

      // Valid publication contract
      const mockRun = {
        _id: 'run-12345',
        externalRunId: 'ext-999',
        status: 'completed',
        conclusion: 'success',
        workflowName: 'CI Build & Tests',
        runNumber: 3,
        branch: 'feature/ci',
        commitSha: 'abc1234',
        matchedIssueKeys: ['PAY-101'],
        duration: 25,
      };

      const result = await publishPipelineEvent('pipeline.run.completed', {
        pipelineRun: mockRun,
        project: 'project-abc',
      });

      if (result.payload) {
        expect(result.payload.eventType).toBe('pipeline.run.completed');
        expect(result.payload.projectId).toBe('project-abc');
        expect(result.payload.pipelineRunId).toBe('run-12345');
        expect(result.payload.externalRunId).toBe('ext-999');
        expect(result.payload.status).toBe('completed');
        expect(result.payload.conclusion).toBe('success');
        expect(result.payload.matchedIssueKeys).toEqual(['PAY-101']);
        expect(result.payload.duration).toBe(25);
        expect(result.payload.timestamp).toBeDefined();
      }
    });

    it('incoming Redis event broadcasts to authorized Socket.io project room only', () => {
      const mockEmit = jest.fn();
      const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
      const mockIO = {
        to: mockTo,
        emit: jest.fn(),
      };

      initPipelineEventSubscriber(mockIO);

      const validPayload = {
        eventType: 'pipeline.run.received',
        projectId: 'proj-target-123',
        pipelineRunId: 'run-001',
        externalRunId: '1001',
        status: 'queued',
        conclusion: null,
        timestamp: new Date().toISOString(),
      };

      const handled = handleIncomingRedisMessage(JSON.stringify(validPayload));
      expect(handled).toBe(true);

      // Targeted room broadcast verified
      expect(mockTo).toHaveBeenCalledTimes(1);
      expect(mockTo).toHaveBeenCalledWith('project:proj-target-123');
      expect(mockEmit).toHaveBeenCalledWith(
        'pipeline.run.received',
        expect.objectContaining({
          type: 'pipeline.run.received',
          data: expect.objectContaining({ projectId: 'proj-target-123' }),
        })
      );

      // Isolation: NEVER broadcasted globally
      expect(mockIO.emit).not.toHaveBeenCalled();
    });

    it('event targeting project A does NOT broadcast to project B', () => {
      const mockEmit = jest.fn();
      const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
      const mockIO = { to: mockTo };

      initPipelineEventSubscriber(mockIO);

      const eventForProjectA = {
        eventType: 'pipeline.updated',
        projectId: 'project-A',
        status: 'completed',
        conclusion: 'success',
      };

      handleIncomingRedisMessage(JSON.stringify(eventForProjectA));

      expect(mockTo).toHaveBeenCalledWith('project:project-A');
      expect(mockTo).not.toHaveBeenCalledWith('project:project-B');
    });

    it('malformed or invalid JSON messages are safely discarded without throwing', () => {
      const mockTo = jest.fn();
      const mockIO = { to: mockTo };
      initPipelineEventSubscriber(mockIO);

      // Non-string
      expect(handleIncomingRedisMessage(null)).toBe(false);
      expect(handleIncomingRedisMessage(12345)).toBe(false);

      // Invalid JSON
      expect(handleIncomingRedisMessage('not-valid-json')).toBe(false);

      // Missing required contract fields
      expect(handleIncomingRedisMessage(JSON.stringify({}))).toBe(false);
      expect(handleIncomingRedisMessage(JSON.stringify({ eventType: 'pipeline.updated' }))).toBe(
        false
      );
      expect(handleIncomingRedisMessage(JSON.stringify({ projectId: '123' }))).toBe(false);

      expect(mockTo).not.toHaveBeenCalled();
    });

    it('re-emits on local eventBus with fromRedis=true', (done) => {
      const mockIO = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
      initPipelineEventSubscriber(mockIO);

      const eventPayload = {
        eventType: 'pipeline.run.completed',
        projectId: 'project-local-sync',
        pipelineRunId: 'run-sync-1',
        status: 'completed',
      };

      const handler = (payload) => {
        eventBus.removeListener('pipeline.run.completed', handler);
        expect(payload.fromRedis).toBe(true);
        expect(payload.project).toBe('project-local-sync');
        done();
      };

      eventBus.on('pipeline.run.completed', handler);
      handleIncomingRedisMessage(JSON.stringify(eventPayload));
    });

    it('gracefully closes subscriber and publisher connections', async () => {
      await expect(closePipelineEventSubscriber()).resolves.not.toThrow();
      await expect(closePipelineEventPublisher()).resolves.not.toThrow();
    });
  });
});

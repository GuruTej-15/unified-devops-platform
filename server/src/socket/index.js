import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import ProjectMember from '../modules/projects/projectMember.model.js';
import eventBus from '../modules/notifications/eventBus.js';
import { initPipelineEventSubscriber } from '../modules/cicd/events/ciEventBridge.js';
import logger from '../shared/logger.js';

let io = null;

/**
 * Initialize Socket.io server with JWT cookie authentication.
 * Rooms are organized as `project:{projectId}`.
 */
export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: config.cors.origin,
      credentials: true,
    },
    path: '/socket.io',
  });

  // JWT authentication middleware for socket connections
  io.use((socket, next) => {
    try {
      // Try cookie first, then auth query param
      const cookieHeader = socket.handshake.headers.cookie || '';
      const cookies = Object.fromEntries(
        cookieHeader.split(';').map((c) => {
          const [k, ...v] = c.trim().split('=');
          return [k, v.join('=')];
        })
      );

      const token = cookies[config.jwt.cookieName] || socket.handshake.auth?.token;

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, config.jwt.secret, {
        algorithms: ['HS256'],
      });
      socket.user = decoded;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    logger.debug(`Socket connected: ${socket.user.email}`);

    // Join project rooms with authorization verification
    socket.on('join:project', async (projectId) => {
      try {
        if (!projectId) return;

        // Platform admins bypass project membership checks
        if (socket.user.role === 'admin') {
          socket.join(`project:${projectId}`);
          logger.debug(`${socket.user.email} (admin) joined project:${projectId}`);
          return;
        }

        const membership = await ProjectMember.findOne({
          project: projectId,
          user: socket.user.id,
        });

        if (membership) {
          socket.join(`project:${projectId}`);
          logger.debug(`${socket.user.email} joined project:${projectId}`);
        } else {
          logger.warn(
            `Unauthorized socket join attempt by ${socket.user.email} for project:${projectId}`
          );
          socket.emit('error', { message: 'Unauthorized: You are not a member of this project' });
        }
      } catch (err) {
        logger.error('Socket join:project error:', err.message);
      }
    });

    socket.on('leave:project', (projectId) => {
      socket.leave(`project:${projectId}`);
    });

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${socket.user.email}`);
    });
  });

  // Wire domain events to Socket.io broadcasts
  setupEventBroadcasts();

  // Initialize cross-process Redis Pub/Sub subscriber for CI/CD events
  initPipelineEventSubscriber(io);

  logger.info('Socket.io initialized');
  return io;
}

export function getIO() {
  return io;
}

/**
 * Subscribe to domain events and broadcast to relevant Socket.io rooms.
 */
function setupEventBroadcasts() {
  const projectEvents = [
    'issue.created',
    'issue.updated',
    'issue.status.changed',
    'issue.commented',
    'issue.deleted',
    'project.updated',
    'project.member.added',
    'project.member.removed',
    'repository.connected',
    'repository.synced',
    'repository.sync.failed',
    'pipeline.run.received',
    'pipeline.run.completed',
    'pipeline.updated',
    'security.scan.processing',
    'security.scan.completed',
    'security.scan.failed',
    'policy.gate.evaluated',
    'policy.gate.overridden',
  ];

  for (const event of projectEvents) {
    eventBus.on(event, (payload) => {
      // Discard if Socket.io uninitialized or if event originated from Redis (already broadcasted)
      if (!io || payload?.fromRedis) return;

      // Determine project ID from payload
      const projectId =
        payload.project?._id?.toString() ||
        payload.project?.toString() ||
        payload.issue?.project?.toString() ||
        payload.repository?.project?.toString();

      if (projectId) {
        io.to(`project:${projectId}`).emit(event, {
          type: event,
          data: payload,
          timestamp: new Date().toISOString(),
        });
      }
    });
  }
}

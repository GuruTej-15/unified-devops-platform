import config from '../../../config/index.js';
import { createRedisConnection } from '../../../config/redis.js';
import eventBus from '../../notifications/eventBus.js';
import logger from '../../../shared/logger.js';

let publisherClient = null;
let subscriberClient = null;
let currentIO = null;
let isSubscribed = false;

/**
 * Get or initialize dedicated publisher Redis client.
 */
export async function getPublisherClient() {
  if (publisherClient) return publisherClient;

  try {
    publisherClient = createRedisConnection();
    await publisherClient.connect();
    logger.info('CI Event Bridge: Redis publisher connected');
    return publisherClient;
  } catch (err) {
    logger.warn(`CI Event Bridge: Publisher connection failed: ${err.message}`);
    if (config.env === 'production') {
      throw err;
    }
    return null;
  }
}

/**
 * Publish a pipeline domain event through Redis Pub/Sub and local eventBus.
 *
 * @param {string} eventType - e.g. 'pipeline.run.received', 'pipeline.run.completed', 'pipeline.updated'
 * @param {object} eventData - { pipelineRun, project, repository, stats }
 */
export async function publishPipelineEvent(
  eventType,
  { pipelineRun, project, repository, stats } = {}
) {
  const projectId = String(
    project?._id || project || pipelineRun?.project?._id || pipelineRun?.project || ''
  );

  if (!eventType || !projectId) {
    logger.warn('CI Event Bridge: Cannot publish event without eventType and projectId', {
      eventType,
      projectId,
    });
    return { published: false, reason: 'Missing required event fields' };
  }

  // 1. Construct versionable, safe event contract payload
  const eventPayload = {
    eventType,
    projectId,
    pipelineRunId: pipelineRun?._id ? String(pipelineRun._id) : null,
    externalRunId: pipelineRun?.externalRunId ? String(pipelineRun.externalRunId) : null,
    status: pipelineRun?.status || null,
    conclusion: pipelineRun?.conclusion || null,
    workflowName: pipelineRun?.workflowName || null,
    runNumber: pipelineRun?.runNumber || null,
    branch: pipelineRun?.branch || null,
    commitSha: pipelineRun?.commitSha || null,
    matchedIssueKeys: pipelineRun?.matchedIssueKeys || [],
    duration: pipelineRun?.duration ?? null,
    repositoryId: repository?._id
      ? String(repository._id)
      : pipelineRun?.repository?._id
        ? String(pipelineRun.repository._id)
        : pipelineRun?.repository
          ? String(pipelineRun.repository)
          : null,
    stats: stats || null,
    timestamp: new Date().toISOString(),
  };

  // 2. Always emit on local process eventBus for in-process listeners
  eventBus.emit(eventType, {
    pipelineRun,
    project: projectId,
    repository,
    stats,
    fromRedis: false,
  });

  // 3. Publish to Redis channel for cross-process delivery
  const channel = config.cicd.eventChannel || 'cicd:pipeline-events';

  try {
    const publisher = await getPublisherClient();
    if (!publisher) {
      if (config.env === 'production') {
        throw new Error('Redis publisher connection unavailable in production environment');
      }
      logger.warn(
        '[NON-DURABLE DEV FALLBACK] Redis publisher unavailable; event emitted in-process only'
      );
      return { published: false, fallbackInProcess: true };
    }

    const serialized = JSON.stringify(eventPayload);
    const receiverCount = await publisher.publish(channel, serialized);
    logger.debug(
      `Published '${eventType}' to Redis channel '${channel}' (${receiverCount} subscriber(s))`
    );
    return { published: true, receiverCount, payload: eventPayload };
  } catch (err) {
    logger.error(`CI Event Bridge: Failed to publish '${eventType}' to Redis: ${err.message}`);
    if (config.env === 'production') {
      throw err;
    }
    return { published: false, error: err.message };
  }
}

/**
 * Publish a security/governance domain event through Redis Pub/Sub and local eventBus.
 *
 * @param {string} eventType - e.g. 'security.scan.completed', 'policy.gate.evaluated'
 * @param {object} eventData - event payload fields
 */
export async function publishSecurityEvent(eventType, eventData = {}) {
  const projectId = String(
    eventData.projectId || eventData.project?._id || eventData.project || ''
  );

  if (!eventType || !projectId) {
    logger.warn('Security Event Bridge: Cannot publish event without eventType and projectId', {
      eventType,
      projectId,
    });
    return { published: false, reason: 'Missing required event fields' };
  }

  // Safe, compact, secret-free event payload envelope
  const eventPayload = {
    domain: 'security',
    eventType,
    ...eventData,
    projectId, // ensure string projectId
    timestamp: eventData.timestamp || new Date().toISOString(),
  };

  // 1. Always emit on local process eventBus for in-process listeners
  eventBus.emit(eventType, {
    ...eventPayload,
    project: projectId,
    fromRedis: false,
  });

  // 2. Publish to Redis channel for cross-process delivery
  const channel = config.cicd.eventChannel || 'cicd:pipeline-events';

  try {
    const publisher = await getPublisherClient();
    if (!publisher) {
      if (config.env === 'production') {
        throw new Error('Redis publisher connection unavailable in production environment');
      }
      logger.warn(
        '[NON-DURABLE DEV FALLBACK] Redis publisher unavailable; security event emitted in-process only'
      );
      return { published: false, fallbackInProcess: true, payload: eventPayload };
    }

    const serialized = JSON.stringify(eventPayload);
    const receiverCount = await publisher.publish(channel, serialized);
    logger.debug(
      `Published security event '${eventType}' to Redis channel '${channel}' (${receiverCount} subscriber(s))`
    );
    return { published: true, receiverCount, payload: eventPayload };
  } catch (err) {
    logger.error(
      `Security Event Bridge: Failed to publish '${eventType}' to Redis: ${err.message}`
    );
    if (config.env === 'production') {
      throw err;
    }
    return { published: false, error: err.message, payload: eventPayload };
  }
}

/**
 * Publish a deployment domain event through Redis Pub/Sub and local eventBus.
 *
 * @param {string} eventType - e.g. 'deployment.queued', 'deployment.started', 'deployment.completed', 'deployment.failed'
 * @param {object} eventData - deployment payload fields
 */
export async function publishDeploymentEvent(eventType, eventData = {}) {
  const projectId = String(
    eventData.projectId || eventData.project?._id || eventData.project || ''
  );

  if (!eventType || !projectId) {
    logger.warn('Deployment Event Bridge: Cannot publish event without eventType and projectId', {
      eventType,
      projectId,
    });
    return { published: false, reason: 'Missing required event fields' };
  }

  // Safe, compact, secret-free deployment event payload envelope
  const eventPayload = {
    domain: 'deployment',
    eventType,
    ...eventData,
    projectId,
    timestamp: eventData.timestamp || new Date().toISOString(),
  };

  // 1. Emit on local process eventBus
  eventBus.emit(eventType, {
    ...eventPayload,
    project: projectId,
    fromRedis: false,
  });

  // 2. Publish to Redis channel for cross-process delivery
  const channel = config.cicd.eventChannel || 'cicd:pipeline-events';

  try {
    const publisher = await getPublisherClient();
    if (!publisher) {
      if (config.env === 'production') {
        throw new Error('Redis publisher connection unavailable in production environment');
      }
      logger.warn(
        '[NON-DURABLE DEV FALLBACK] Redis publisher unavailable; deployment event emitted in-process only'
      );
      return { published: false, fallbackInProcess: true, payload: eventPayload };
    }

    const serialized = JSON.stringify(eventPayload);
    const receiverCount = await publisher.publish(channel, serialized);
    logger.debug(
      `Published deployment event '${eventType}' to Redis channel '${channel}' (${receiverCount} subscriber(s))`
    );
    return { published: true, receiverCount, payload: eventPayload };
  } catch (err) {
    logger.error(
      `Deployment Event Bridge: Failed to publish '${eventType}' to Redis: ${err.message}`
    );
    if (config.env === 'production') {
      throw err;
    }
    return { published: false, error: err.message, payload: eventPayload };
  }
}

/**
 * Initialize dedicated Redis subscriber connection in the API server process
 * and route received events to the authorized Socket.io project room.
 *
 * @param {object} io - Socket.io Server instance
 */
export async function initPipelineEventSubscriber(io) {
  if (io) {
    currentIO = io;
  }

  if (isSubscribed && subscriberClient) {
    logger.debug('CI Event Bridge: Already subscribed to Redis channel');
    return subscriberClient;
  }

  const channel = config.cicd.eventChannel || 'cicd:pipeline-events';

  try {
    // Subscriber MUST use a dedicated connection and cannot share connections in SUBSCRIBE mode
    subscriberClient = createRedisConnection();
    await subscriberClient.connect();

    subscriberClient.on('message', (ch, message) => {
      if (ch !== channel) return;
      handleIncomingRedisMessage(message);
    });

    subscriberClient.on('error', (err) => {
      logger.warn(`CI Event Bridge subscriber warning: ${err.message}`);
    });

    await subscriberClient.subscribe(channel);
    isSubscribed = true;
    logger.info(`CI Event Bridge: Subscribed to Redis channel '${channel}'`);
    return subscriberClient;
  } catch (err) {
    logger.warn(`CI Event Bridge subscriber initialization failed: ${err.message}`);
    if (config.env === 'production') {
      throw err;
    }
    return null;
  }
}

/**
 * Safely parse, validate, and broadcast incoming Redis Pub/Sub messages.
 */
export function handleIncomingRedisMessage(rawMessage) {
  try {
    if (!rawMessage || typeof rawMessage !== 'string') {
      logger.warn('CI Event Bridge: Discarded non-string Redis message');
      return false;
    }

    const data = JSON.parse(rawMessage);

    // Validation guard: reject malformed or missing fields
    if (
      !data ||
      typeof data !== 'object' ||
      typeof data.eventType !== 'string' ||
      typeof data.projectId !== 'string' ||
      !data.eventType.trim() ||
      !data.projectId.trim()
    ) {
      logger.warn('CI Event Bridge: Discarded malformed CI event payload from Redis', { data });
      return false;
    }

    // 1. Broadcast to authorized project room only (NEVER globally)
    if (currentIO) {
      currentIO.to(`project:${data.projectId}`).emit(data.eventType, {
        type: data.eventType,
        data,
        timestamp: data.timestamp || new Date().toISOString(),
      });
      logger.debug(`Socket.io broadcasted '${data.eventType}' to room project:${data.projectId}`);
    }

    // 2. Re-emit on API process eventBus so local event listeners (audit log, etc.) receive it
    eventBus.emit(data.eventType, {
      ...(data.domain === 'security' ? data : { pipelineRun: data }),
      project: data.projectId,
      fromRedis: true,
    });

    return true;
  } catch (err) {
    logger.warn(`CI Event Bridge: JSON parse error for Redis message: ${err.message}`);
    return false;
  }
}

/**
 * Gracefully close subscriber connection.
 */
export async function closePipelineEventSubscriber() {
  if (subscriberClient) {
    try {
      const channel = config.cicd.eventChannel || 'cicd:pipeline-events';
      if (isSubscribed) {
        await subscriberClient.unsubscribe(channel).catch(() => {});
      }
      await subscriberClient.quit().catch(() => subscriberClient.disconnect());
      logger.info('CI Event Bridge: Subscriber disconnected cleanly');
    } catch (err) {
      logger.warn(`CI Event Bridge: Error closing subscriber: ${err.message}`);
    } finally {
      subscriberClient = null;
      isSubscribed = false;
    }
  }
}

/**
 * Gracefully close publisher connection.
 */
export async function closePipelineEventPublisher() {
  if (publisherClient) {
    try {
      await publisherClient.quit().catch(() => publisherClient.disconnect());
      logger.info('CI Event Bridge: Publisher disconnected cleanly');
    } catch (err) {
      logger.warn(`CI Event Bridge: Error closing publisher: ${err.message}`);
    } finally {
      publisherClient = null;
    }
  }
}

/**
 * Reset helper for testing.
 */
export function _resetEventBridgeState() {
  currentIO = null;
  isSubscribed = false;
}

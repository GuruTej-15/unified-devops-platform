import { Redis } from 'ioredis';
import config from './index.js';
import logger from '../shared/logger.js';

let sharedClient = null;

/**
 * Creates a new Redis connection configured for BullMQ and general use.
 * BullMQ requires `maxRetriesPerRequest: null`.
 */
export function createRedisConnection(customOptions = {}) {
  const redisUrl = config.redis.url || 'redis://localhost:6379';

  const defaultOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
      if (config.env === 'production') {
        const delay = Math.min(times * 200, 5000);
        return delay;
      }
      // In dev/test, don't spam infinite reconnect loops if Redis isn't up
      if (times > 3) {
        return null; // Stop reconnecting in dev
      }
      return 1000;
    },
    lazyConnect: true,
  };

  const client = new Redis(redisUrl, {
    ...defaultOptions,
    ...customOptions,
  });

  client.on('error', (err) => {
    logger.warn(`Redis connection warning: ${err.message}`);
  });

  return client;
}

/**
 * Get or create a shared Redis client instance.
 */
export async function getRedisClient() {
  if (sharedClient) return sharedClient;

  try {
    sharedClient = createRedisConnection();
    await sharedClient.connect();
    logger.info('Connected to Redis');
    return sharedClient;
  } catch (err) {
    logger.warn(`Redis initial connection failed: ${err.message}`);
    if (config.env === 'production') {
      throw err;
    }
    return null;
  }
}

export const connectRedis = async () => {
  return getRedisClient();
};

export default {
  createRedisConnection,
  getRedisClient,
  connectRedis,
};

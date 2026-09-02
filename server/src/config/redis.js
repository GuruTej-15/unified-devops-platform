// Redis connection placeholder for Phase 2.
// Phase 2 will use Redis for:
// - BullMQ / Redis Streams (durable event processing)
// - Socket.io adapter (multi-node scaling)
// - Cache layer

import logger from '../shared/logger.js';

export const connectRedis = async () => {
  logger.info('Redis connection: skipped (Phase 2)');
  return null;
};

import { connectDatabase } from '../config/database.js';
import { connectRedis } from '../config/redis.js';
import { initCiWorker } from '../modules/cicd/queue/ciWorker.js';
import { scheduleRepeatableReconciliation } from '../modules/cicd/queue/ciQueue.js';
import logger from '../shared/logger.js';

logger.info('====================================================');
logger.info('  UNIFIED DEVOPS PLATFORM — CI BACKGROUND WORKER     ');
logger.info('====================================================');

async function startWorkerProcess() {
  try {
    // 1. Connect MongoDB
    await connectDatabase();

    // 2. Connect Redis
    await connectRedis();

    // 3. Start BullMQ Worker
    const worker = initCiWorker();

    // 4. Schedule authoritative repeatable reconciliation in BullMQ
    await scheduleRepeatableReconciliation();

    logger.info('CI Background Worker is active and listening for jobs');

    // Graceful shutdown handling
    const shutdown = async (signal) => {
      logger.info(`Received ${signal}. Gracefully stopping CI worker...`);
      try {
        await worker.close();
        logger.info('CI Worker stopped cleanly.');
        process.exit(0);
      } catch (err) {
        logger.error(`Error during worker shutdown: ${err.message}`);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    logger.error(`Fatal CI Worker initialization error: ${err.message}`);
    process.exit(1);
  }
}

startWorkerProcess();

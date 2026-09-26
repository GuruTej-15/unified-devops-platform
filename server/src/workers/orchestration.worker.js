import connectDB from '../config/database.js';
import { connectRedis } from '../config/redis.js';
import { initOrchestrationWorker } from '../modules/orchestration/orchestrationWorker.js';
import {
  scheduleRepeatableOrchestrationReconciliation,
  closeOrchestrationQueue,
} from '../modules/orchestration/orchestrationQueue.js';
import logger from '../shared/logger.js';

logger.info('====================================================');
logger.info('  UNIFIED DEVOPS PLATFORM — ORCHESTRATION WORKER    ');
logger.info('====================================================');

async function startWorkerProcess() {
  try {
    // 1. Connect MongoDB
    await connectDB();

    // 2. Connect Redis
    await connectRedis();

    // 3. Start BullMQ Worker
    const worker = initOrchestrationWorker();

    // 4. Schedule authoritative repeatable reconciliation in BullMQ
    await scheduleRepeatableOrchestrationReconciliation();

    logger.info('Orchestration Background Worker is active and listening for jobs');

    // Graceful shutdown handling
    const shutdown = async (signal) => {
      logger.info(`Received ${signal}. Gracefully stopping Orchestration worker...`);
      try {
        await worker.close();
        await closeOrchestrationQueue();
        logger.info('Orchestration Worker stopped cleanly.');
        process.exit(0);
      } catch (err) {
        logger.error(`Error during worker shutdown: ${err.message}`);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    logger.error(`Fatal Orchestration Worker initialization error: ${err.message}`);
    process.exit(1);
  }
}

startWorkerProcess();

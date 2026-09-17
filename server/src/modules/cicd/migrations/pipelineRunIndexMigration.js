import mongoose from 'mongoose';
import logger from '../../../shared/logger.js';

/**
 * Authoritative, idempotent database index migration utility for PipelineRun.
 * Drops ONLY the legacy repository_1_externalRunId_1 unique index if present,
 * creates the new provider-aware compound unique index:
 *   { repository: 1, provider: 1, jenkinsIntegration: 1, externalRunId: 1 }
 * and preserves all other existing indexes without destructive cleanup.
 */
export async function migratePipelineRunIndexes() {
  try {
    const collection = mongoose.connection.db.collection('pipelineruns');
    const existingIndexes = await collection.indexes();

    // 1. Check for legacy index
    const legacyIndex = existingIndexes.find((i) => i.name === 'repository_1_externalRunId_1');
    if (legacyIndex) {
      logger.info('Index migration: Dropping legacy index repository_1_externalRunId_1...');
      try {
        await collection.dropIndex('repository_1_externalRunId_1');
        logger.info(
          'Index migration: Successfully dropped legacy index repository_1_externalRunId_1'
        );
      } catch (dropErr) {
        if (dropErr.codeName !== 'IndexNotFound') {
          logger.warn(`Index migration: dropIndex warning: ${dropErr.message}`);
        }
      }
    } else {
      logger.info(
        'Index migration: Legacy index repository_1_externalRunId_1 not present (already migrated)'
      );
    }

    // 2. Ensure new compound unique index exists
    const targetIndexName = 'repository_1_provider_1_jenkinsIntegration_1_externalRunId_1';
    const targetIndexExists = existingIndexes.some((i) => i.name === targetIndexName);

    if (!targetIndexExists) {
      logger.info(`Index migration: Creating compound unique index ${targetIndexName}...`);
      await collection.createIndex(
        { repository: 1, provider: 1, jenkinsIntegration: 1, externalRunId: 1 },
        { unique: true, background: true, name: targetIndexName }
      );
      logger.info(`Index migration: Created compound unique index ${targetIndexName}`);
    }

    // 3. Ensure jenkinsIntegration index exists
    const jenkinsIndexName = 'jenkinsIntegration_1';
    const jenkinsIndexExists = existingIndexes.some((i) => i.name === jenkinsIndexName);
    if (!jenkinsIndexExists) {
      await collection.createIndex(
        { jenkinsIntegration: 1 },
        { background: true, name: jenkinsIndexName }
      );
    }

    // 4. Verify resulting indexes
    const updatedIndexes = await collection.indexes();
    logger.info(
      `Index migration complete. Active PipelineRun indexes: ${updatedIndexes.map((i) => i.name).join(', ')}`
    );
    return updatedIndexes;
  } catch (err) {
    logger.error(`Index migration failed: ${err.message}`);
    throw err;
  }
}

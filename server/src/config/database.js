import mongoose from 'mongoose';
import { migratePipelineRunIndexes } from '../modules/cicd/migrations/pipelineRunIndexMigration.js';
import logger from '../shared/logger.js';

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(
      process.env.MONGODB_URI || 'mongodb://localhost:27017/unified-devops'
    );
    logger.info(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
    await migratePipelineRunIndexes();
    return conn;
  } catch (error) {
    logger.error('MongoDB connection failed:', error.message);
    process.exit(1);
  }
};

// Graceful shutdown
mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  logger.error('MongoDB connection error:', err.message);
});

export default connectDB;

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,

  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/unified-devops',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
    cookieName: 'udp_token',
  },

  encryption: {
    key: process.env.ENCRYPTION_KEY || '',
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },

  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  cicd: {
    queueName: process.env.CI_QUEUE_NAME || 'ci-events',
    workerConcurrency: parseInt(process.env.CI_WORKER_CONCURRENCY, 10) || 5,
    jobAttempts: parseInt(process.env.CI_JOB_ATTEMPTS, 10) || 5,
    backoffMs: parseInt(process.env.CI_JOB_BACKOFF_MS, 10) || 2000,
    reconciliationLookbackMinutes:
      parseInt(process.env.CI_RECONCILIATION_LOOKBACK_MINUTES, 10) || 60,
    reconciliationIntervalMinutes:
      parseInt(process.env.CI_RECONCILIATION_INTERVAL_MINUTES, 10) || 15,
    eventChannel: process.env.CI_EVENT_CHANNEL || 'cicd:pipeline-events',
  },
};

// Validate critical config in production
if (config.env === 'production') {
  const required = ['JWT_SECRET', 'ENCRYPTION_KEY', 'MONGODB_URI', 'REDIS_URL'];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }
}

export default config;

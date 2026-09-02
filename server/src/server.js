import http from 'node:http';
import config from './config/index.js';
import connectDB from './config/database.js';
import app from './app.js';
import { initSocket } from './socket/index.js';
import logger from './shared/logger.js';

const startServer = async () => {
  // Connect to MongoDB
  await connectDB();

  // Create HTTP server
  const server = http.createServer(app);

  // Initialize Socket.io
  initSocket(server);

  // Start listening
  server.listen(config.port, () => {
    logger.info(`🚀 Server running on port ${config.port} [${config.env}]`);
    logger.info(`   Health: http://localhost:${config.port}/api/v1/health`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

startServer().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});

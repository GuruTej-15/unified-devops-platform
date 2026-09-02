import logger from '../shared/logger.js';

/**
 * HTTP request logger middleware.
 * Logs method, URL, status, and response time.
 * Never logs request bodies (may contain credentials).
 */
const requestLogger = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
};

export default requestLogger;

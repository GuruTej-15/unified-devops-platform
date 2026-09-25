import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import config from './config/index.js';
import { defaultLimiter } from './middleware/rateLimiter.js';
import requestLogger from './middleware/requestLogger.js';
import errorHandler from './middleware/errorHandler.js';

// Route imports
import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/users/user.routes.js';
import projectRoutes from './modules/projects/project.routes.js';
import issueRoutes from './modules/issues/issue.routes.js';
import vcsRoutes from './modules/vcs/vcs.routes.js';
import cicdRoutes from './modules/cicd/cicd.routes.js';
import webhookRoutes from './modules/cicd/webhook.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import securityRoutes from './modules/security/security.routes.js';
import deploymentRoutes from './modules/deployment/deployment.routes.js';
import orchestrationRoutes from './modules/orchestration/orchestration.routes.js';

const app = express();

// --- Security middleware ---
app.use(helmet());
app.use(
  cors({
    origin: config.cors.origin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Hub-Signature-256',
      'X-GitHub-Delivery',
      'X-GitHub-Event',
      'X-Jenkins-Token',
      'X-Security-Token',
    ],
  })
);

// --- Parsing (preserve rawBody for HMAC-SHA256 signature verification) ---
app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// --- Rate limiting ---
app.use('/api/', defaultLimiter);

// --- Request logging ---
app.use(requestLogger);

// --- Health check ---
app.get('/api/v1/health', (_req, res) => {
  res.json({
    success: true,
    message: 'Unified DevOps Platform API is running',
    data: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: config.env,
    },
  });
});

// --- API routes ---
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/projects', projectRoutes);
app.use('/api/v1/audit-logs', auditRoutes);
app.use('/api/v1/webhooks', webhookRoutes);

// Nested under projects
app.use('/api/v1/projects/:projectId/issues', issueRoutes);
app.use('/api/v1/projects/:projectId/repositories', vcsRoutes);
app.use('/api/v1/projects/:projectId/security', securityRoutes);
app.use('/api/v1/projects/:projectId/deployments', deploymentRoutes);
app.use('/api/v1/projects/:projectId/orchestration', orchestrationRoutes);
app.use('/api/v1/projects/:projectId', cicdRoutes);

// --- 404 handler ---
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// --- Error handler ---
app.use(errorHandler);

export default app;

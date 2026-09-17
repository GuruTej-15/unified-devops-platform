import { Router } from 'express';
import { handleGitHubWebhook, handleJenkinsWebhook } from './cicd.controller.js';
import { handleSecurityWebhook } from '../security/security.controller.js';

const router = Router();

// Public GitHub webhook endpoint (HMAC-SHA256 authenticated via X-Hub-Signature-256)
router.post('/github', handleGitHubWebhook);

// Public Jenkins webhook endpoint (X-Jenkins-Token authenticated against integrationId)
router.post('/jenkins/:integrationId', handleJenkinsWebhook);

// Public Security scanner webhook endpoint (X-Security-Token authenticated against integrationId)
router.post('/security/:integrationId', handleSecurityWebhook);

export default router;

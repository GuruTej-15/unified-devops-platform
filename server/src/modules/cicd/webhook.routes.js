import { Router } from 'express';
import { handleGitHubWebhook, handleJenkinsWebhook } from './cicd.controller.js';

const router = Router();

// Public GitHub webhook endpoint (HMAC-SHA256 authenticated via X-Hub-Signature-256)
router.post('/github', handleGitHubWebhook);

// Public Jenkins webhook endpoint (X-Jenkins-Token authenticated against integrationId)
router.post('/jenkins/:integrationId', handleJenkinsWebhook);

export default router;

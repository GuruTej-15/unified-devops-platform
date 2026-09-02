import { Router } from 'express';
import { handleGitHubWebhook } from './cicd.controller.js';

const router = Router();

// Public GitHub webhook endpoint (HMAC-SHA256 authenticated via X-Hub-Signature-256)
router.post('/github', handleGitHubWebhook);

export default router;

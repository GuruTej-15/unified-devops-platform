import { Router } from 'express';
import authenticate from '../../middleware/authenticate.js';
import projectAccess from '../../middleware/projectAccess.js';
import * as controller from './deployment.controller.js';

// Project-scoped router (inherits :projectId from parent mount)
const router = Router({ mergeParams: true });

router.post(
  '/',
  authenticate,
  projectAccess('owner', 'admin', 'developer'),
  controller.ingestDeployment
);
router.post(
  '/ingest',
  authenticate,
  projectAccess('owner', 'admin', 'developer'),
  controller.ingestDeployment
);
router.get('/', authenticate, projectAccess(), controller.listDeployments);
router.get('/:deploymentId', authenticate, projectAccess(), controller.getDeployment);

export default router;

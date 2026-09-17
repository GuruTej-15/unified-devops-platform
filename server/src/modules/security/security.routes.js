import { Router } from 'express';
import authenticate from '../../middleware/authenticate.js';
import projectAccess from '../../middleware/projectAccess.js';
import * as controller from './security.controller.js';

// Project-scoped router (inherits :projectId from parent mount)
const router = Router({ mergeParams: true });

// Security Integration CRUD
router.post(
  '/integrations',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.createSecurityIntegration
);

router.get('/integrations', authenticate, projectAccess(), controller.listSecurityIntegrations);

router.get(
  '/integrations/:integrationId',
  authenticate,
  projectAccess(),
  controller.getSecurityIntegration
);

router.patch(
  '/integrations/:integrationId',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.updateSecurityIntegration
);

router.post(
  '/integrations/:integrationId/rotate',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.rotateSecurityIntegrationSecret
);

router.delete(
  '/integrations/:integrationId',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.deleteSecurityIntegration
);

export default router;

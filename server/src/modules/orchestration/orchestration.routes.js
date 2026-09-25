import { Router } from 'express';
import authenticate from '../../middleware/authenticate.js';
import projectAccess from '../../middleware/projectAccess.js';
import * as controller from './orchestration.controller.js';

// Project-scoped router (inherits :projectId from parent mount)
const router = Router({ mergeParams: true });

router.post(
  '/integrations',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.createOrchestrationIntegration
);

router.get(
  '/integrations',
  authenticate,
  projectAccess(),
  controller.listOrchestrationIntegrations
);

router.get(
  '/integrations/:integrationId',
  authenticate,
  projectAccess(),
  controller.getOrchestrationIntegration
);

router.patch(
  '/integrations/:integrationId',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.updateOrchestrationIntegration
);

router.delete(
  '/integrations/:integrationId',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.deleteOrchestrationIntegration
);

export default router;

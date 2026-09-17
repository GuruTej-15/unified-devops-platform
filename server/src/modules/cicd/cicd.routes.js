import { Router } from 'express';
import authenticate from '../../middleware/authenticate.js';
import projectAccess from '../../middleware/projectAccess.js';
import * as controller from './cicd.controller.js';

// Project-scoped router (merged params with parent :projectId)
const router = Router({ mergeParams: true });

// Pipeline runs
router.get('/pipeline-runs', authenticate, projectAccess(), controller.listProjectPipelineRuns);
router.get('/pipeline-runs/:runId', authenticate, projectAccess(), controller.getPipelineRun);

// Pipelines definitions
router.get('/pipelines', authenticate, projectAccess(), controller.listProjectPipelines);

// Issue-linked pipeline runs
router.get(
  '/issues/:issueKey/pipeline-runs',
  authenticate,
  projectAccess(),
  controller.getIssuePipelineRuns
);

// Manual synchronous reconciliation (repository-scoped)
router.post(
  '/repositories/:repoId/pipelines/sync',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.syncRepositoryPipelines
);

// Asynchronous project reconciliation (Phase 2B BullMQ queue job)
router.post(
  '/cicd/reconcile',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.triggerReconciliation
);

// Queue health & observability diagnostics (Phase 2B)
router.get('/cicd/queue-health', authenticate, projectAccess(), controller.getQueueHealthStatus);

// Jenkins integrations (Phase 2C)
router.post(
  '/cicd/jenkins',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.createJenkinsIntegration
);
router.get('/cicd/jenkins', authenticate, projectAccess(), controller.listJenkinsIntegrations);
router.delete(
  '/cicd/jenkins/:integrationId',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.deleteJenkinsIntegration
);

export default router;

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

// Manual reconciliation
router.post(
  '/repositories/:repoId/pipelines/sync',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.syncRepositoryPipelines
);

export default router;

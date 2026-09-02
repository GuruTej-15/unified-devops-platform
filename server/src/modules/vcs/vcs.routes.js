import { Router } from 'express';
import authenticate from '../../middleware/authenticate.js';
import projectAccess from '../../middleware/projectAccess.js';
import validate from '../../middleware/validate.js';
import { connectRepoSchema } from './vcs.validation.js';
import * as controller from './vcs.controller.js';

const router = Router({ mergeParams: true });

// POST /api/v1/projects/:projectId/repositories
router.post(
  '/',
  authenticate,
  projectAccess('owner', 'admin'),
  validate(connectRepoSchema),
  controller.connectRepository
);

// GET /api/v1/projects/:projectId/repositories
router.get('/', authenticate, projectAccess(), controller.listRepositories);

// GET /api/v1/projects/:projectId/repositories/:repoId
router.get('/:repoId', authenticate, projectAccess(), controller.getRepository);

// DELETE /api/v1/projects/:projectId/repositories/:repoId
router.delete(
  '/:repoId',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.disconnectRepository
);

// POST /api/v1/projects/:projectId/repositories/:repoId/sync
router.post(
  '/:repoId/sync',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.syncRepository
);

// GET /api/v1/projects/:projectId/repositories/:repoId/branches
router.get('/:repoId/branches', authenticate, projectAccess(), controller.getBranches);

// GET /api/v1/projects/:projectId/repositories/:repoId/commits
router.get('/:repoId/commits', authenticate, projectAccess(), controller.getCommits);

// GET /api/v1/projects/:projectId/repositories/:repoId/pull-requests
router.get('/:repoId/pull-requests', authenticate, projectAccess(), controller.getPullRequests);

export default router;

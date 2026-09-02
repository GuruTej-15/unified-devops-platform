import { Router } from 'express';
import authenticate from '../../middleware/authenticate.js';
import projectAccess from '../../middleware/projectAccess.js';
import validate from '../../middleware/validate.js';
import {
  createProjectSchema,
  updateProjectSchema,
  addMemberSchema,
  updateMemberRoleSchema,
} from './project.validation.js';
import * as controller from './project.controller.js';

const router = Router();

router.post('/', authenticate, validate(createProjectSchema), controller.createProject);
router.get('/', authenticate, controller.listProjects);
router.get('/:projectId', authenticate, projectAccess(), controller.getProject);
router.put(
  '/:projectId',
  authenticate,
  projectAccess('owner', 'admin'),
  validate(updateProjectSchema),
  controller.updateProject
);
router.patch(
  '/:projectId/archive',
  authenticate,
  projectAccess('owner'),
  controller.archiveProject
);
router.get('/:projectId/members', authenticate, projectAccess(), controller.getMembers);
router.post(
  '/:projectId/members',
  authenticate,
  projectAccess('owner', 'admin'),
  validate(addMemberSchema),
  controller.addMember
);
router.put(
  '/:projectId/members/:userId',
  authenticate,
  projectAccess('owner', 'admin'),
  validate(updateMemberRoleSchema),
  controller.updateMemberRole
);
router.delete(
  '/:projectId/members/:userId',
  authenticate,
  projectAccess('owner', 'admin'),
  controller.removeMember
);
router.get('/:projectId/dashboard', authenticate, projectAccess(), controller.getDashboard);

export default router;

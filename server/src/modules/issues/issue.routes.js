import { Router } from 'express';
import authenticate from '../../middleware/authenticate.js';
import projectAccess from '../../middleware/projectAccess.js';
import validate from '../../middleware/validate.js';
import {
  createIssueSchema,
  updateIssueSchema,
  createCommentSchema,
  listIssuesQuery,
} from './issue.validation.js';
import * as controller from './issue.controller.js';

const router = Router({ mergeParams: true });

router.post(
  '/',
  authenticate,
  projectAccess(),
  validate(createIssueSchema),
  controller.createIssue
);
router.get(
  '/',
  authenticate,
  projectAccess(),
  validate(listIssuesQuery, 'query'),
  controller.listIssues
);
router.get('/:issueKey', authenticate, projectAccess(), controller.getIssue);
router.put(
  '/:issueKey',
  authenticate,
  projectAccess(),
  validate(updateIssueSchema),
  controller.updateIssue
);
router.delete('/:issueKey', authenticate, projectAccess('owner', 'admin'), controller.deleteIssue);
router.post(
  '/:issueKey/comments',
  authenticate,
  projectAccess(),
  validate(createCommentSchema),
  controller.addComment
);
router.get('/:issueKey/comments', authenticate, projectAccess(), controller.getComments);
router.get('/:issueKey/activity', authenticate, projectAccess(), controller.getIssueActivity);
router.get(
  '/:issueKey/delivery-state',
  authenticate,
  projectAccess(),
  controller.getIssueDeliveryState
);

export default router;

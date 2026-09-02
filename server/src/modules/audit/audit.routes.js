import { Router } from 'express';
import authenticate from '../../middleware/authenticate.js';
import authorize from '../../middleware/authorize.js';
import projectAccess from '../../middleware/projectAccess.js';
import * as controller from './audit.controller.js';

const router = Router();

router.get('/', authenticate, authorize('admin'), controller.listAuditLogs);
router.get('/projects/:projectId', authenticate, projectAccess(), controller.listProjectAuditLogs);

export default router;

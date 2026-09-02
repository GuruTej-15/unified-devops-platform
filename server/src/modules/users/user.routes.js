import { Router } from 'express';
import authenticate from '../../middleware/authenticate.js';
import validate from '../../middleware/validate.js';
import { listUsersQuery } from './user.validation.js';
import UserController from './user.controller.js';

const router = Router();

router.get('/', authenticate, validate(listUsersQuery, 'query'), UserController.listUsers);
router.get('/:userId', authenticate, UserController.getUser);

export default router;

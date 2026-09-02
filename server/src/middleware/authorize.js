import { ForbiddenError } from '../shared/errors.js';

/**
 * Global role-based authorization middleware.
 * Checks the user's platform-wide role (admin, developer, product, etc.)
 *
 * @param  {...string} allowedRoles - Roles allowed to access the route
 */
const authorize = (...allowedRoles) => {
  return (req, _res, next) => {
    if (!req.user) {
      throw new ForbiddenError('Access denied');
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenError('You do not have permission to perform this action');
    }

    next();
  };
};

export default authorize;

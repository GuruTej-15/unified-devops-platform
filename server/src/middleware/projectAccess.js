import ProjectMember from '../modules/projects/projectMember.model.js';
import { ForbiddenError, NotFoundError } from '../shared/errors.js';

/**
 * Project-level access middleware.
 * Verifies the user is a member of the project specified by :projectId.
 * Optionally restricts to specific project roles.
 *
 * Attaches req.projectMember with the membership record.
 *
 * @param  {...string} allowedProjectRoles - If provided, only these project roles pass.
 *                                           If empty, any member passes.
 */
const projectAccess = (...allowedProjectRoles) => {
  return async (req, _res, next) => {
    const { projectId } = req.params;
    const userId = req.user.id;

    if (!projectId) {
      throw new NotFoundError('Project not specified');
    }

    // Platform admins bypass project membership checks
    if (req.user.role === 'admin') {
      req.projectMember = { role: 'admin' };
      return next();
    }

    const membership = await ProjectMember.findOne({
      project: projectId,
      user: userId,
    });

    if (!membership) {
      throw new ForbiddenError('You are not a member of this project');
    }

    // Check specific project role if required
    if (allowedProjectRoles.length > 0 && !allowedProjectRoles.includes(membership.role)) {
      throw new ForbiddenError('Insufficient project permissions');
    }

    req.projectMember = membership;
    next();
  };
};

export default projectAccess;

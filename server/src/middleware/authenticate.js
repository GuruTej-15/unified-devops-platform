import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { UnauthorizedError } from '../shared/errors.js';

/**
 * JWT authentication middleware.
 * Checks HttpOnly cookie first, then falls back to Authorization Bearer header.
 * Attaches decoded user payload to req.user.
 */
const authenticate = (req, _res, next) => {
  let token = null;

  // 1. Check HttpOnly cookie
  if (req.cookies && req.cookies[config.jwt.cookieName]) {
    token = req.cookies[config.jwt.cookieName];
  }

  // 2. Fallback: Authorization Bearer header (for CLI/API clients)
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    throw new UnauthorizedError('Authentication required');
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new UnauthorizedError('Token expired');
    }
    throw new UnauthorizedError('Invalid token');
  }
};

export default authenticate;

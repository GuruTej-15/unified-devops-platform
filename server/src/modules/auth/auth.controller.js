import AuthService from './auth.service.js';
import { sendSuccess, sendCreated } from '../../shared/apiResponse.js';
import config from '../../config/index.js';

const COOKIE_OPTIONS = (env) => ({
  httpOnly: true,
  secure: env === 'production',
  sameSite: 'strict',
  path: '/api/v1',
  maxAge: 24 * 60 * 60 * 1000,
});

class AuthController {
  static async register(req, res) {
    const user = await AuthService.register(req.body);
    const token = AuthService.generateToken(user);

    res.cookie(config.jwt.cookieName, token, COOKIE_OPTIONS(config.env));
    sendCreated(res, { data: user, message: 'User registered successfully' });
  }

  static async login(req, res) {
    const user = await AuthService.login(req.body);
    const token = AuthService.generateToken(user);

    res.cookie(config.jwt.cookieName, token, COOKIE_OPTIONS(config.env));
    sendSuccess(res, { data: user, message: 'Login successful' });
  }

  static async logout(_req, res) {
    res.cookie(config.jwt.cookieName, '', {
      httpOnly: true,
      secure: config.env === 'production',
      sameSite: 'strict',
      path: '/api/v1',
      maxAge: 0,
    });
    sendSuccess(res, { message: 'Logged out successfully' });
  }

  static async getMe(req, res) {
    const user = await AuthService.getProfile(req.user.id);
    sendSuccess(res, { data: user });
  }

  static async updateProfile(req, res) {
    const user = await AuthService.updateProfile(req.user.id, req.body);
    sendSuccess(res, { data: user, message: 'Profile updated' });
  }

  static async changePassword(req, res) {
    await AuthService.changePassword(req.user.id, req.body);
    sendSuccess(res, { message: 'Password changed successfully' });
  }
}

export default AuthController;

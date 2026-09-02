import jwt from 'jsonwebtoken';
import User from '../users/user.model.js';
import config from '../../config/index.js';
import { ConflictError, UnauthorizedError, NotFoundError } from '../../shared/errors.js';
import eventBus from '../notifications/eventBus.js';

class AuthService {
  static async register({ email, username, password, firstName, lastName, role }) {
    const existingEmail = await User.findOne({ email });
    if (existingEmail) throw new ConflictError('Email already in use');

    const existingUsername = await User.findOne({ username });
    if (existingUsername) throw new ConflictError('Username already in use');

    const user = new User({ email, username, password, firstName, lastName, role });
    await user.save();

    eventBus.emit('user.registered', user);

    return user.toProfileJSON();
  }

  static async login({ email, password }) {
    const user = await User.findOne({ email }).select('+password');
    if (!user) throw new UnauthorizedError('Invalid email or password');

    const isMatch = await user.comparePassword(password);
    if (!isMatch) throw new UnauthorizedError('Invalid email or password');

    user.lastLoginAt = new Date();
    await user.save({ validateModifiedOnly: true });

    eventBus.emit('user.login', user);

    return user.toProfileJSON();
  }

  static async getProfile(userId) {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User not found');
    return user.toProfileJSON();
  }

  static async updateProfile(userId, updates) {
    const user = await User.findByIdAndUpdate(userId, updates, { new: true, runValidators: true });
    if (!user) throw new NotFoundError('User not found');
    return user.toProfileJSON();
  }

  static async changePassword(userId, { currentPassword, newPassword }) {
    const user = await User.findById(userId).select('+password');
    if (!user) throw new NotFoundError('User not found');

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) throw new UnauthorizedError('Incorrect current password');

    user.password = newPassword;
    await user.save();

    eventBus.emit('user.passwordChanged', user);
  }

  static generateToken(user) {
    return jwt.sign({ id: user._id, email: user.email, role: user.role }, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
      algorithm: 'HS256',
    });
  }
}

export default AuthService;

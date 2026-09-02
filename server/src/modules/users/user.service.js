import User from './user.model.js';
import { NotFoundError } from '../../shared/errors.js';

class UserService {
  static async listUsers({ search, page = 1, limit = 10 }) {
    const query = {};
    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { email: searchRegex },
        { username: searchRegex },
        { firstName: searchRegex },
        { lastName: searchRegex },
      ];
    }

    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      User.find(query).skip(skip).limit(Number(limit)),
      User.countDocuments(query),
    ]);

    return {
      data: users.map((u) => u.toProfileJSON()),
      total,
      page: Number(page),
      limit: Number(limit),
    };
  }

  static async getUserById(userId) {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User not found');
    return user.toProfileJSON();
  }
}

export default UserService;

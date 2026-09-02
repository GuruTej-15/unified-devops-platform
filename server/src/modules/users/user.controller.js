import UserService from './user.service.js';
import { sendSuccess, sendPaginated } from '../../shared/apiResponse.js';

class UserController {
  static async listUsers(req, res) {
    const { search, page, limit } = req.query;
    const result = await UserService.listUsers({ search, page, limit });
    sendPaginated(res, {
      data: result.data,
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  }

  static async getUser(req, res) {
    const user = await UserService.getUserById(req.params.userId);
    sendSuccess(res, { data: user });
  }
}

export default UserController;

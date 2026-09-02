import Project from './project.model.js';
import ProjectMember from './projectMember.model.js';
import ProjectCounter from './projectCounter.model.js';
import User from '../users/user.model.js';
import { NotFoundError, ConflictError } from '../../shared/errors.js';
import eventBus from '../notifications/eventBus.js';
import { INITIAL_ISSUE_COUNTER } from '../../shared/constants.js';

export default class ProjectService {
  static async createProject(data, userId) {
    const project = await Project.create({ ...data, owner: userId });

    await ProjectCounter.create({
      project: project._id,
      currentSeq: INITIAL_ISSUE_COUNTER,
    });

    await ProjectMember.create({
      project: project._id,
      user: userId,
      role: 'owner',
    });

    eventBus.emit('project.created', { project, actor: userId });

    return Project.findById(project._id).populate('owner', 'firstName lastName email');
  }

  static async listUserProjects(userId, { page = 1, limit = 20 }) {
    const memberships = await ProjectMember.find({ user: userId });
    const projectIds = memberships.map((m) => m.project);

    const skip = (page - 1) * limit;
    const [projects, total] = await Promise.all([
      Project.find({ _id: { $in: projectIds } })
        .populate('owner', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Project.countDocuments({ _id: { $in: projectIds } }),
    ]);

    return { data: projects, total, page, limit };
  }

  static async getProjectById(projectId) {
    const project = await Project.findById(projectId).populate('owner', 'firstName lastName email');
    if (!project) throw new NotFoundError('Project not found');
    return project;
  }

  static async updateProject(projectId, updates) {
    const project = await Project.findByIdAndUpdate(projectId, updates, {
      new: true,
      runValidators: true,
    });
    if (!project) throw new NotFoundError('Project not found');
    eventBus.emit('project.updated', { project });
    return project;
  }

  static async archiveProject(projectId) {
    const project = await Project.findByIdAndUpdate(
      projectId,
      { status: 'archived' },
      { new: true }
    );
    if (!project) throw new NotFoundError('Project not found');
    eventBus.emit('project.archived', { project });
    return project;
  }

  static async addMember(projectId, userId, role) {
    const userExists = await User.findById(userId);
    if (!userExists) throw new NotFoundError('User not found');

    const existing = await ProjectMember.findOne({ project: projectId, user: userId });
    if (existing) throw new ConflictError('User is already a member of this project');

    const member = await ProjectMember.create({ project: projectId, user: userId, role });
    await member.populate('user', 'firstName lastName email username avatar role');

    eventBus.emit('project.member.added', { project: projectId, member });
    return member;
  }

  static async removeMember(projectId, userId) {
    const member = await ProjectMember.findOneAndDelete({ project: projectId, user: userId });
    if (!member) throw new NotFoundError('Member not found');
    eventBus.emit('project.member.removed', { project: projectId, userId });
    return member;
  }

  static async updateMemberRole(projectId, userId, role) {
    const member = await ProjectMember.findOneAndUpdate(
      { project: projectId, user: userId },
      { role },
      { new: true, runValidators: true }
    );
    if (!member) throw new NotFoundError('Member not found');
    eventBus.emit('project.member.updated', { project: projectId, member });
    return member;
  }

  static async getMembers(projectId, { page = 1, limit = 20 }) {
    const skip = (page - 1) * limit;
    const [members, total] = await Promise.all([
      ProjectMember.find({ project: projectId })
        .populate('user', 'firstName lastName email username avatar role')
        .skip(skip)
        .limit(limit),
      ProjectMember.countDocuments({ project: projectId }),
    ]);
    return { data: members, total, page, limit };
  }
}

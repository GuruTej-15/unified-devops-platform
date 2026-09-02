import ProjectService from './project.service.js';
import DashboardService from './dashboard.service.js';
import { sendCreated, sendSuccess, sendPaginated } from '../../shared/apiResponse.js';

export const createProject = async (req, res) => {
  const project = await ProjectService.createProject(req.body, req.user.id);
  sendCreated(res, { data: project, message: 'Project created successfully' });
};

export const listProjects = async (req, res) => {
  const { data, total, page, limit } = await ProjectService.listUserProjects(req.user.id, {
    page: parseInt(req.query.page, 10) || 1,
    limit: parseInt(req.query.limit, 10) || 20,
  });
  sendPaginated(res, { data, page, limit, total });
};

export const getProject = async (req, res) => {
  const project = await ProjectService.getProjectById(req.params.projectId);
  sendSuccess(res, { data: project });
};

export const updateProject = async (req, res) => {
  const project = await ProjectService.updateProject(req.params.projectId, req.body);
  sendSuccess(res, { data: project, message: 'Project updated' });
};

export const archiveProject = async (req, res) => {
  const project = await ProjectService.archiveProject(req.params.projectId);
  sendSuccess(res, { data: project, message: 'Project archived' });
};

export const addMember = async (req, res) => {
  const member = await ProjectService.addMember(
    req.params.projectId,
    req.body.userId,
    req.body.role
  );
  sendCreated(res, { data: member, message: 'Member added' });
};

export const removeMember = async (req, res) => {
  await ProjectService.removeMember(req.params.projectId, req.params.userId);
  sendSuccess(res, { message: 'Member removed' });
};

export const updateMemberRole = async (req, res) => {
  const member = await ProjectService.updateMemberRole(
    req.params.projectId,
    req.params.userId,
    req.body.role
  );
  sendSuccess(res, { data: member, message: 'Member role updated' });
};

export const getMembers = async (req, res) => {
  const { data, total, page, limit } = await ProjectService.getMembers(req.params.projectId, {
    page: parseInt(req.query.page, 10) || 1,
    limit: parseInt(req.query.limit, 10) || 20,
  });
  sendPaginated(res, { data, page, limit, total });
};

export const getDashboard = async (req, res) => {
  const data = await DashboardService.getDashboardData(req.params.projectId);
  sendSuccess(res, { data });
};

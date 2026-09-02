import VcsService from './vcs.service.js';
import { sendSuccess, sendCreated, sendPaginated } from '../../shared/apiResponse.js';

export const connectRepository = async (req, res) => {
  const repo = await VcsService.connectRepository(req.params.projectId, req.body, req.user.id);
  sendCreated(res, { data: repo, message: 'Repository connected successfully' });
};

export const listRepositories = async (req, res) => {
  const repos = await VcsService.listRepositories(req.params.projectId);
  sendSuccess(res, { data: repos });
};

export const getRepository = async (req, res) => {
  const repo = await VcsService.getRepositoryById(req.params.repoId);
  sendSuccess(res, { data: repo });
};

export const disconnectRepository = async (req, res) => {
  await VcsService.disconnectRepository(req.params.repoId, req.user.id);
  sendSuccess(res, { message: 'Repository disconnected' });
};

export const syncRepository = async (req, res) => {
  const stats = await VcsService.syncRepository(req.params.repoId);
  sendSuccess(res, { data: stats, message: 'Repository synced successfully' });
};

export const getBranches = async (req, res) => {
  const branches = await VcsService.getBranches(req.params.repoId);
  sendSuccess(res, { data: branches });
};

export const getCommits = async (req, res) => {
  const { commits, total, page, limit } = await VcsService.getCommits(req.params.repoId, req.query);
  sendPaginated(res, { data: commits, page, limit, total });
};

export const getPullRequests = async (req, res) => {
  const { pullRequests, total, page, limit } = await VcsService.getPullRequests(
    req.params.repoId,
    req.query
  );
  sendPaginated(res, { data: pullRequests, page, limit, total });
};

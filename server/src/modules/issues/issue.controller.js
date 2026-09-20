import IssueService from './issue.service.js';
import { sendCreated, sendSuccess, sendPaginated } from '../../shared/apiResponse.js';

export const createIssue = async (req, res) => {
  const issue = await IssueService.createIssue(req.params.projectId, req.body, req.user.id);
  sendCreated(res, { data: issue, message: 'Issue created successfully' });
};

export const listIssues = async (req, res) => {
  const { data, total, page, limit } = await IssueService.listIssues(
    req.params.projectId,
    req.query
  );
  sendPaginated(res, { data, page, limit, total });
};

export const getIssue = async (req, res) => {
  const issue = await IssueService.getIssueByKey(
    req.params.projectId,
    req.params.issueKey.toUpperCase()
  );
  sendSuccess(res, { data: issue });
};

export const updateIssue = async (req, res) => {
  const issue = await IssueService.updateIssue(
    req.params.projectId,
    req.params.issueKey.toUpperCase(),
    req.body,
    req.user.id
  );
  sendSuccess(res, { data: issue, message: 'Issue updated' });
};

export const deleteIssue = async (req, res) => {
  await IssueService.deleteIssue(req.params.projectId, req.params.issueKey.toUpperCase());
  sendSuccess(res, { message: 'Issue deleted' });
};

export const addComment = async (req, res) => {
  const comment = await IssueService.addComment(
    req.params.projectId,
    req.params.issueKey.toUpperCase(),
    req.body.body,
    req.user.id
  );
  sendCreated(res, { data: comment, message: 'Comment added' });
};
export const getComments = async (req, res) => {
  const { data, total, page, limit } = await IssueService.getComments(
    req.params.projectId,
    req.params.issueKey.toUpperCase(),
    {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 20,
    }
  );
  sendPaginated(res, { data, page, limit, total });
};

export const getIssueActivity = async (req, res) => {
  const activity = await IssueService.getIssueActivity(
    req.params.projectId,
    req.params.issueKey.toUpperCase()
  );
  sendSuccess(res, { data: activity });
};

export const getIssueDeliveryState = async (req, res) => {
  const deliveryState = await IssueService.getIssueDeliveryState(
    req.params.projectId,
    req.params.issueKey.toUpperCase()
  );
  sendSuccess(res, { data: deliveryState });
};

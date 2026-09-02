import Issue from './issue.model.js';
import Comment from './comment.model.js';
import Project from '../projects/project.model.js';
import ProjectCounter from '../projects/projectCounter.model.js';
import Commit from '../vcs/commit.model.js';
import PullRequest from '../vcs/pullRequest.model.js';
import PipelineRun from '../cicd/pipelineRun.model.js';
import { NotFoundError } from '../../shared/errors.js';
import eventBus from '../notifications/eventBus.js';

export default class IssueService {
  static async createIssue(projectId, data, reporterId) {
    const project = await Project.findById(projectId);
    if (!project) throw new NotFoundError('Project not found');

    const nextSeq = await ProjectCounter.getNextSequence(projectId);
    const issueKey = `${project.key}-${nextSeq}`;

    const issue = await Issue.create({
      ...data,
      project: projectId,
      issueKey,
      issueNumber: nextSeq,
      reporter: reporterId,
    });

    const populated = await Issue.findById(issue._id)
      .populate('assignee', 'firstName lastName email username avatar')
      .populate('reporter', 'firstName lastName email username avatar');

    eventBus.emit('issue.created', { issue: populated, actor: reporterId, project: projectId });
    return populated;
  }

  static async listIssues(projectId, filters = {}) {
    const {
      status,
      priority,
      type,
      assignee,
      search,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = filters;

    const query = { project: projectId };
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (type) query.type = type;
    if (assignee) query.assignee = assignee;
    if (search) query.title = { $regex: search, $options: 'i' };

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(100, parseInt(limit, 10) || 20);
    const skip = (pageNum - 1) * limitNum;
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const [issues, total] = await Promise.all([
      Issue.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .populate('assignee', 'firstName lastName email username avatar')
        .populate('reporter', 'firstName lastName email username avatar'),
      Issue.countDocuments(query),
    ]);

    return { data: issues, total, page: pageNum, limit: limitNum };
  }

  static async getIssueByKey(projectId, issueKey) {
    const issue = await Issue.findOne({ project: projectId, issueKey })
      .populate('assignee', 'firstName lastName email username avatar')
      .populate('reporter', 'firstName lastName email username avatar');
    if (!issue) throw new NotFoundError('Issue not found');
    return issue;
  }

  static async updateIssue(projectId, issueKey, updates, actorId) {
    const issue = await Issue.findOne({ project: projectId, issueKey });
    if (!issue) throw new NotFoundError('Issue not found');

    const oldStatus = issue.status;
    const oldAssignee = issue.assignee?.toString();

    Object.assign(issue, updates);
    await issue.save();

    const populated = await Issue.findById(issue._id)
      .populate('assignee', 'firstName lastName email username avatar')
      .populate('reporter', 'firstName lastName email username avatar');

    eventBus.emit('issue.updated', {
      issue: populated,
      actor: actorId,
      project: projectId,
      changes: updates,
    });

    if (updates.status && updates.status !== oldStatus) {
      eventBus.emit('issue.status.changed', {
        issue: populated,
        actor: actorId,
        project: projectId,
        oldStatus,
        newStatus: updates.status,
      });
    }
    if (updates.assignee !== undefined && updates.assignee !== oldAssignee) {
      eventBus.emit('issue.assigned', {
        issue: populated,
        actor: actorId,
        project: projectId,
        oldAssignee,
        newAssignee: updates.assignee,
      });
    }

    return populated;
  }

  static async deleteIssue(projectId, issueKey) {
    const issue = await Issue.findOne({ project: projectId, issueKey });
    if (!issue) throw new NotFoundError('Issue not found');
    await issue.deleteOne();
    eventBus.emit('issue.deleted', { issueKey, projectId, issueId: issue._id });
  }

  static async addComment(projectId, issueKey, body, authorId) {
    const issue = await Issue.findOne({ project: projectId, issueKey });
    if (!issue) throw new NotFoundError('Issue not found');

    const comment = await Comment.create({ issue: issue._id, author: authorId, body });
    const populated = await Comment.findById(comment._id).populate(
      'author',
      'firstName lastName email username avatar'
    );

    eventBus.emit('issue.commented', {
      issue,
      comment: populated,
      actor: authorId,
      project: projectId,
    });
    return populated;
  }

  static async getComments(projectId, issueKey, { page = 1, limit = 20 }) {
    const issue = await Issue.findOne({ project: projectId, issueKey });
    if (!issue) throw new NotFoundError('Issue not found');

    const skip = (page - 1) * limit;
    const [comments, total] = await Promise.all([
      Comment.find({ issue: issue._id })
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'firstName lastName email username avatar'),
      Comment.countDocuments({ issue: issue._id }),
    ]);

    return { data: comments, total, page, limit };
  }

  static async getIssueActivity(projectId, issueKey) {
    const [commits, pullRequests, pipelineRuns] = await Promise.all([
      Commit.find({ project: projectId, matchedIssueKeys: issueKey }).sort({ authoredAt: -1 }),
      PullRequest.find({ project: projectId, matchedIssueKeys: issueKey }).sort({ updatedAt: -1 }),
      PipelineRun.find({ project: projectId, matchedIssueKeys: issueKey }).sort({
        startedAt: -1,
        createdAt: -1,
      }),
    ]);

    const branches = new Set();
    pullRequests.forEach((pr) => {
      if (pr.sourceBranch) branches.add(pr.sourceBranch);
    });
    pipelineRuns.forEach((run) => {
      if (run.branch) branches.add(run.branch);
    });

    return { commits, pullRequests, branches: Array.from(branches), pipelineRuns };
  }
}

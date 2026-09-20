import Issue from './issue.model.js';
import Comment from './comment.model.js';
import Project from '../projects/project.model.js';
import ProjectCounter from '../projects/projectCounter.model.js';
import Commit from '../vcs/commit.model.js';
import PullRequest from '../vcs/pullRequest.model.js';
import PipelineRun from '../cicd/pipelineRun.model.js';
import { NotFoundError } from '../../shared/errors.js';
import eventBus from '../notifications/eventBus.js';
import SecurityDeliveryStateService from '../security/securityDeliveryState.service.js';

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

  static async getIssueDeliveryState(projectId, issueKey) {
    const normalizedKey = issueKey.trim().toUpperCase();

    // 1. Verify issue exists
    const issue = await Issue.findOne({ project: projectId, issueKey: normalizedKey })
      .populate('reporter', 'firstName lastName email username avatar')
      .populate('assignee', 'firstName lastName email username avatar');

    if (!issue) {
      throw new NotFoundError(`Issue '${issueKey}' not found`);
    }

    // 2. Load VCS and CI activity in parallel
    const [commits, pullRequests, pipelineRuns] = await Promise.all([
      Commit.find({ project: projectId, matchedIssueKeys: normalizedKey }).sort({ authoredAt: -1 }),
      PullRequest.find({ project: projectId, matchedIssueKeys: normalizedKey }).sort({
        updatedAt: -1,
      }),
      PipelineRun.find({ project: projectId, matchedIssueKeys: normalizedKey }).sort({
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

    const branchList = Array.from(branches);
    const latestPR = pullRequests[0] || null;
    const latestCommit = commits[0] || null;
    const latestRun = pipelineRuns[0] || null;

    // 3. Authoritative Security and Governance projection
    const securityProjection = await SecurityDeliveryStateService.getIssueSecurityProjection(
      projectId,
      normalizedKey
    );

    // 4. Assemble authoritative delivery state
    return {
      issueKey: normalizedKey,
      issue: {
        _id: issue._id,
        issueKey: issue.issueKey,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        type: issue.type,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      },
      stages: {
        issue: {
          id: 'issue',
          name: 'Issue',
          status: 'completed',
          badge: issue.status,
        },
        branch: {
          id: 'branch',
          name: 'Branch',
          status: branchList.length > 0 ? 'completed' : 'pending',
          detected: branchList.length > 0,
          branches: branchList,
        },
        commit: {
          id: 'commit',
          name: 'Commits',
          status: commits.length > 0 ? 'completed' : 'pending',
          count: commits.length,
          latestCommit: latestCommit
            ? {
                sha: latestCommit.sha,
                message: latestCommit.message,
                authoredAt: latestCommit.authoredAt,
              }
            : null,
        },
        pr: {
          id: 'pr',
          name: 'Pull Request',
          status: latestPR ? (latestPR.state === 'merged' ? 'completed' : 'active') : 'pending',
          latestPR: latestPR
            ? {
                number: latestPR.number,
                title: latestPR.title,
                state: latestPR.state,
                url: latestPR.url,
              }
            : null,
        },
        ci: {
          id: 'ci',
          name: 'CI / Build Pipeline',
          status: latestRun
            ? latestRun.status === 'completed'
              ? latestRun.conclusion === 'success'
                ? 'completed'
                : 'failed'
              : 'active'
            : 'pending',
          latestRun: latestRun
            ? {
                _id: latestRun._id,
                runNumber: latestRun.runNumber,
                workflowName: latestRun.workflowName,
                status: latestRun.status,
                conclusion: latestRun.conclusion,
                duration: latestRun.duration,
              }
            : null,
        },
        security: {
          id: 'security',
          name: 'Security',
          ...securityProjection.security,
        },
        governance: {
          id: 'governance',
          name: 'Governance',
          ...securityProjection.governance,
        },
      },
      security: securityProjection.security,
      governance: securityProjection.governance,
      traceability: securityProjection.traceability,
    };
  }
}

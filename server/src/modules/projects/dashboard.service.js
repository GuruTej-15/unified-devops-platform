import mongoose from 'mongoose';
import ProjectMember from './projectMember.model.js';
import Issue from '../issues/issue.model.js';
import AuditLog from '../audit/audit.model.js';
import Repository from '../vcs/repository.model.js';
import Commit from '../vcs/commit.model.js';
import PullRequest from '../vcs/pullRequest.model.js';
import PipelineRun from '../cicd/pipelineRun.model.js';

export default class DashboardService {
  static async getDashboardData(projectId) {
    const objectProjectId = new mongoose.Types.ObjectId(projectId);

    const [
      memberCount,
      issueStats,
      issuePriorityStats,
      recentIssues,
      recentActivity,
      repositoryCount,
      recentCommits,
      recentPullRequests,
      pipelineRunsGrouped,
      recentPipelineRuns,
    ] = await Promise.all([
      ProjectMember.countDocuments({ project: projectId }),
      Issue.aggregate([
        { $match: { project: objectProjectId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Issue.aggregate([
        { $match: { project: objectProjectId } },
        { $group: { _id: '$priority', count: { $sum: 1 } } },
      ]),
      Issue.find({ project: projectId })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('assignee', 'firstName lastName email avatar username')
        .populate('reporter', 'firstName lastName email avatar username'),
      AuditLog.find({ projectId })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('actor', 'firstName lastName email'),
      Repository.countDocuments({ project: projectId }),
      Commit.find({ project: projectId }).sort({ authoredAt: -1 }).limit(5),
      PullRequest.find({ project: projectId }).sort({ updatedAt: -1 }).limit(5),
      PipelineRun.aggregate([
        { $match: { project: objectProjectId } },
        {
          $group: {
            _id: {
              status: '$status',
              conclusion: '$conclusion',
            },
            count: { $sum: 1 },
          },
        },
      ]),
      PipelineRun.find({ project: projectId })
        .sort({ startedAt: -1, createdAt: -1 })
        .limit(5)
        .populate('repository', 'name fullName defaultBranch')
        .populate('pipeline', 'name'),
    ]);

    // Normalize pipeline health stats
    const pipelineStats = {
      passing: 0,
      failing: 0,
      running: 0,
      queued: 0,
      total: 0,
    };

    pipelineRunsGrouped.forEach((group) => {
      const { status, conclusion } = group._id;
      const count = group.count;
      pipelineStats.total += count;

      if (status === 'completed' && conclusion === 'success') {
        pipelineStats.passing += count;
      } else if (
        status === 'completed' &&
        (conclusion === 'failure' || conclusion === 'timed_out')
      ) {
        pipelineStats.failing += count;
      } else if (status === 'in_progress') {
        pipelineStats.running += count;
      } else if (status === 'queued') {
        pipelineStats.queued += count;
      }
    });

    return {
      issueStats,
      issuePriorityStats,
      recentIssues,
      recentActivity,
      memberCount,
      repositoryCount,
      recentCommits,
      recentPullRequests,
      pipelineStats,
      recentPipelineRuns,
    };
  }
}

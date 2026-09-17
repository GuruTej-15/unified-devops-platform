import mongoose from 'mongoose';
import {
  CI_PROVIDER,
  CI_PROVIDER_VALUES,
  PIPELINE_STATUS,
  PIPELINE_STATUS_VALUES,
  PIPELINE_CONCLUSION_VALUES,
} from '../../shared/constants.js';

export const STATUS_WEIGHT = {
  queued: 1,
  in_progress: 2,
  completed: 3,
};

const pipelineRunSchema = new mongoose.Schema(
  {
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    repository: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Repository',
      required: true,
    },
    pipeline: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pipeline',
    },
    provider: {
      type: String,
      enum: CI_PROVIDER_VALUES,
      default: CI_PROVIDER.GITHUB_ACTIONS,
      required: true,
    },
    jenkinsIntegration: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JenkinsIntegration',
      default: null,
    },
    providerEvent: {
      type: String,
      default: 'workflow_run',
      trim: true,
    },
    providerAction: {
      type: String,
      default: '',
      trim: true,
    },
    webhookDeliveryId: {
      type: String,
      default: '',
      trim: true,
    },
    webhookReceivedAt: {
      type: Date,
      default: Date.now,
    },
    externalRunId: {
      type: String,
      required: true,
      trim: true,
    },
    runNumber: {
      type: Number,
      required: true,
    },
    workflowName: {
      type: String,
      required: true,
      trim: true,
    },
    workflowPath: {
      type: String,
      default: '',
      trim: true,
    },
    commitSha: {
      type: String,
      required: false,
      default: '',
      trim: true,
    },
    branch: {
      type: String,
      default: '',
      trim: true,
    },
    pullRequestNumber: {
      type: Number,
      default: null,
    },
    pullRequest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PullRequest',
      default: null,
    },
    matchedIssueKeys: {
      type: [String],
      default: [],
    },
    eventType: {
      type: String,
      default: 'push',
      trim: true,
    },
    status: {
      type: String,
      enum: PIPELINE_STATUS_VALUES,
      default: PIPELINE_STATUS.QUEUED,
      required: true,
    },
    conclusion: {
      type: String,
      enum: [...PIPELINE_CONCLUSION_VALUES, null],
      default: null,
    },
    htmlUrl: {
      type: String,
      default: '',
      trim: true,
    },
    startedAt: Date,
    completedAt: Date,
    duration: {
      type: Number, // In seconds
      default: null,
    },
    actor: {
      login: { type: String, default: 'github-actions' },
      avatarUrl: { type: String, default: '' },
    },
    headCommitMessage: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

pipelineRunSchema.index(
  { repository: 1, provider: 1, jenkinsIntegration: 1, externalRunId: 1 },
  { unique: true }
);
pipelineRunSchema.index({ jenkinsIntegration: 1 });
pipelineRunSchema.index({ project: 1, createdAt: -1 });
pipelineRunSchema.index({ commitSha: 1 });
pipelineRunSchema.index({ matchedIssueKeys: 1 });
pipelineRunSchema.index({ pullRequestNumber: 1 });
pipelineRunSchema.index({ status: 1 });
pipelineRunSchema.index({ webhookDeliveryId: 1 });

/**
 * Checks if status progression is valid (prevents terminal 'completed' status from regressing).
 */
pipelineRunSchema.statics.isStatusProgressionAllowed = function (currentStatus, incomingStatus) {
  if (!currentStatus) return true;
  const currentWeight = STATUS_WEIGHT[currentStatus] || 0;
  const incomingWeight = STATUS_WEIGHT[incomingStatus] || 0;
  return incomingWeight >= currentWeight;
};

/**
 * Idempotently upserts a PipelineRun while protecting terminal status and conclusion.
 */
pipelineRunSchema.statics.upsertWithStatusGuard = async function (filter, updateData) {
  const existing = await this.findOne(filter);

  if (existing) {
    // If existing run is already in terminal or advanced status, do not regress status or clear conclusion
    const currentWeight = STATUS_WEIGHT[existing.status] || 0;
    const incomingWeight = STATUS_WEIGHT[updateData.status] || 0;

    if (incomingWeight < currentWeight) {
      // Retain existing status and conclusion
      updateData.status = existing.status;
      if (existing.conclusion && !updateData.conclusion) {
        updateData.conclusion = existing.conclusion;
      }
      if (existing.completedAt && !updateData.completedAt) {
        updateData.completedAt = existing.completedAt;
      }
      if (existing.duration != null && updateData.duration == null) {
        updateData.duration = existing.duration;
      }
    }
  }

  return this.findOneAndUpdate(filter, updateData, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });
};

const PipelineRun = mongoose.model('PipelineRun', pipelineRunSchema);
export default PipelineRun;

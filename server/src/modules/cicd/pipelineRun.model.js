import mongoose from 'mongoose';
import {
  CI_PROVIDER,
  CI_PROVIDER_VALUES,
  PIPELINE_STATUS,
  PIPELINE_STATUS_VALUES,
  PIPELINE_CONCLUSION_VALUES,
} from '../../shared/constants.js';

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
      required: true,
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

pipelineRunSchema.index({ repository: 1, externalRunId: 1 }, { unique: true });
pipelineRunSchema.index({ project: 1, createdAt: -1 });
pipelineRunSchema.index({ commitSha: 1 });
pipelineRunSchema.index({ matchedIssueKeys: 1 });
pipelineRunSchema.index({ pullRequestNumber: 1 });
pipelineRunSchema.index({ status: 1 });
pipelineRunSchema.index({ webhookDeliveryId: 1 });

const PipelineRun = mongoose.model('PipelineRun', pipelineRunSchema);
export default PipelineRun;

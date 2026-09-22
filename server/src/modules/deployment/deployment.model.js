import mongoose from 'mongoose';
import {
  DEPLOYMENT_PROVIDER_VALUES,
  DEPLOYMENT_STATUS,
  DEPLOYMENT_STATUS_VALUES,
  DEPLOYMENT_GOVERNANCE_STATE,
  DEPLOYMENT_GOVERNANCE_STATE_VALUES,
} from '../../shared/constants.js';

const ALLOWED_PROVIDERS = DEPLOYMENT_PROVIDER_VALUES;

const deploymentSchema = new mongoose.Schema(
  {
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: [true, 'Project reference is required'],
      index: true,
    },
    repository: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Repository',
      default: null,
    },
    pipelineRun: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PipelineRun',
      default: null,
      index: true,
    },
    provider: {
      type: String,
      required: [true, 'Deployment provider is required'],
      enum: {
        values: ALLOWED_PROVIDERS,
        message: 'Invalid deployment provider: {VALUE}',
      },
    },
    environment: {
      type: String,
      required: [true, 'Deployment environment is required'],
      trim: true,
      default: 'production',
      index: true,
    },
    externalDeploymentId: {
      type: String,
      required: [true, 'External deployment ID is required'],
      trim: true,
    },
    commitSha: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
    branch: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: {
        values: DEPLOYMENT_STATUS_VALUES,
        message: 'Invalid deployment status: {VALUE}',
      },
      default: DEPLOYMENT_STATUS.QUEUED,
      index: true,
    },
    url: {
      type: String,
      trim: true,
      default: null,
    },
    actor: {
      type: String,
      trim: true,
      default: null,
    },
    governanceDecision: {
      type: String,
      enum: {
        values: DEPLOYMENT_GOVERNANCE_STATE_VALUES,
        message: 'Invalid deployment governance state: {VALUE}',
      },
      default: DEPLOYMENT_GOVERNANCE_STATE.NOT_EVALUATED,
      index: true,
    },
    governanceGateResult: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PolicyGateResult',
      default: null,
    },
    isGovernanceViolation: {
      type: Boolean,
      default: false,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    duration: {
      type: Number,
      default: null,
    },
    errorMessage: {
      type: String,
      trim: true,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: Provider-aware & environment-scoped deployment identity
deploymentSchema.index(
  { project: 1, provider: 1, environment: 1, externalDeploymentId: 1 },
  { unique: true }
);

// Rapid delivery state & traceability lookups
deploymentSchema.index({ project: 1, commitSha: 1, createdAt: -1 });
deploymentSchema.index({ project: 1, pipelineRun: 1, createdAt: -1 });

const Deployment = mongoose.model('Deployment', deploymentSchema);

export default Deployment;

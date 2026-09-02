import mongoose from 'mongoose';
import { CI_PROVIDER, CI_PROVIDER_VALUES } from '../../shared/constants.js';

const pipelineSchema = new mongoose.Schema(
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
    provider: {
      type: String,
      enum: CI_PROVIDER_VALUES,
      default: CI_PROVIDER.GITHUB_ACTIONS,
      required: true,
    },
    externalWorkflowId: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    path: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

pipelineSchema.index({ repository: 1, externalWorkflowId: 1 }, { unique: true });
pipelineSchema.index({ project: 1 });

const Pipeline = mongoose.model('Pipeline', pipelineSchema);
export default Pipeline;

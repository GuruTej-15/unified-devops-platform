import mongoose from 'mongoose';
import {
  ORCHESTRATION_PROVIDER_VALUES,
  ORCHESTRATION_STATUS,
  ORCHESTRATION_STATUS_VALUES,
  DEPLOYMENT_ENVIRONMENT,
  DEPLOYMENT_ENVIRONMENT_VALUES,
} from '../../shared/constants.js';

const orchestrationIntegrationSchema = new mongoose.Schema(
  {
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: [true, 'Project reference is required'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Integration name is required'],
      trim: true,
      minlength: [2, 'Integration name must be at least 2 characters'],
      maxlength: [100, 'Integration name cannot exceed 100 characters'],
    },
    provider: {
      type: String,
      enum: {
        values: ORCHESTRATION_PROVIDER_VALUES,
        message: 'Invalid orchestration provider: {VALUE}',
      },
      required: [true, 'Orchestration provider is required'],
      index: true,
    },
    environment: {
      type: String,
      enum: {
        values: DEPLOYMENT_ENVIRONMENT_VALUES,
        message: 'Invalid environment: {VALUE}',
      },
      default: DEPLOYMENT_ENVIRONMENT.PRODUCTION,
      required: [true, 'Deployment environment is required'],
      index: true,
    },
    serverUrl: {
      type: String,
      required: [true, 'Server URL is required'],
      trim: true,
    },
    status: {
      type: String,
      enum: {
        values: ORCHESTRATION_STATUS_VALUES,
        message: 'Invalid orchestration status: {VALUE}',
      },
      default: ORCHESTRATION_STATUS.CONNECTED,
      required: true,
      index: true,
    },

    // Kubernetes-specific configuration
    namespace: {
      type: String,
      trim: true,
      default: null,
    },
    caCertificate: {
      type: String,
      default: null,
      select: false,
    },

    // Argo CD-specific configuration
    applicationName: {
      type: String,
      trim: true,
      default: null,
    },

    // Encrypted token credentials (AES-256-GCM, select: false)
    encryptedToken: {
      type: String,
      required: [true, 'Encrypted token is required'],
      select: false,
    },
    tokenIv: {
      type: String,
      required: [true, 'Token IV is required'],
      select: false,
    },
    tokenAuthTag: {
      type: String,
      required: [true, 'Token Auth Tag is required'],
      select: false,
    },
    tokenHint: {
      type: String,
      default: '',
      trim: true,
    },

    // Operational observation metadata
    lastHealthCheckAt: {
      type: Date,
      default: null,
    },
    lastErrorMessage: {
      type: String,
      default: null,
      trim: true,
    },

    // Ownership & tracking
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Created by user is required'],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Security: Never serialize sensitive tokens or raw certificates into JSON or plain objects
orchestrationIntegrationSchema.set('toJSON', {
  transform: function (_doc, ret) {
    delete ret.encryptedToken;
    delete ret.tokenIv;
    delete ret.tokenAuthTag;
    delete ret.caCertificate;
    return ret;
  },
});

orchestrationIntegrationSchema.set('toObject', {
  transform: function (_doc, ret) {
    delete ret.encryptedToken;
    delete ret.tokenIv;
    delete ret.tokenAuthTag;
    delete ret.caCertificate;
    return ret;
  },
});

// Indexes: Enforce unique integration name within a project and fast scoped lookups
orchestrationIntegrationSchema.index({ project: 1, name: 1 }, { unique: true });
orchestrationIntegrationSchema.index({ project: 1, provider: 1, environment: 1 });

const OrchestrationIntegration = mongoose.model(
  'OrchestrationIntegration',
  orchestrationIntegrationSchema
);

export default OrchestrationIntegration;

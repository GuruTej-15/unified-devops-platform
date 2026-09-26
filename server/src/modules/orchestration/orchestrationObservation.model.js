import mongoose from 'mongoose';
import {
  ORCHESTRATION_PROVIDER_VALUES,
  DEPLOYMENT_ENVIRONMENT_VALUES,
  ORCHESTRATION_HEALTH_STATUS,
  ORCHESTRATION_HEALTH_STATUS_VALUES,
  ORCHESTRATION_SYNC_STATUS,
  ORCHESTRATION_SYNC_STATUS_VALUES,
} from '../../shared/constants.js';

const orchestrationObservationSchema = new mongoose.Schema(
  {
    integration: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OrchestrationIntegration',
      required: true,
      index: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ORCHESTRATION_PROVIDER_VALUES,
      required: true,
      index: true,
    },
    environment: {
      type: String,
      enum: DEPLOYMENT_ENVIRONMENT_VALUES,
      required: true,
      index: true,
    },
    // Deterministic workload identifier unique within the integration
    // e.g., 'argocd:application::payment-service' or 'kubernetes:deployment:production:payment-api'
    workloadIdentifier: {
      type: String,
      required: true,
      trim: true,
    },
    workload: {
      name: {
        type: String,
        required: true,
        trim: true,
      },
      kind: {
        type: String,
        default: 'Deployment',
        trim: true,
      },
      namespace: {
        type: String,
        default: '',
        trim: true,
      },
    },
    health: {
      status: {
        type: String,
        enum: ORCHESTRATION_HEALTH_STATUS_VALUES,
        default: ORCHESTRATION_HEALTH_STATUS.UNKNOWN,
        index: true,
      },
      reason: {
        type: String,
        default: '',
        trim: true,
      },
      message: {
        type: String,
        default: '',
        trim: true,
      },
    },
    sync: {
      status: {
        type: String,
        enum: ORCHESTRATION_SYNC_STATUS_VALUES,
        default: ORCHESTRATION_SYNC_STATUS.UNKNOWN,
        index: true,
      },
      revision: {
        type: String,
        default: null,
        trim: true,
      },
    },
    drift: {
      hasDrift: {
        type: Boolean,
        default: false,
        index: true,
      },
      reasons: {
        type: [String],
        default: [],
      },
    },
    runtime: {
      desiredReplicas: { type: Number, default: null },
      readyReplicas: { type: Number, default: null },
      availableReplicas: { type: Number, default: null },
      updatedReplicas: { type: Number, default: null },
      generation: { type: Number, default: null },
      observedGeneration: { type: Number, default: null },
      currentRevision: { type: String, default: null },
      resources: { type: Array, default: [] },
      outOfSyncResources: { type: Array, default: [] },
      containers: { type: Array, default: [] },
      operationPhase: { type: String, default: null },
    },
    status: {
      type: String,
      default: 'unknown',
    },
    observedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    lastError: {
      message: { type: String, default: '' },
      code: { type: String, default: '' },
      occurredAt: { type: Date, default: null },
    },
    deliveryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OrchestrationDelivery',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index ensuring latest authoritative observation per integration & workload
orchestrationObservationSchema.index({ integration: 1, workloadIdentifier: 1 }, { unique: true });

orchestrationObservationSchema.index({ project: 1, environment: 1, observedAt: -1 });

const OrchestrationObservation = mongoose.model(
  'OrchestrationObservation',
  orchestrationObservationSchema
);

export default OrchestrationObservation;

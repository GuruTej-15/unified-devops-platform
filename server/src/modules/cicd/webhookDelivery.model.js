import mongoose from 'mongoose';

const webhookDeliverySchema = new mongoose.Schema(
  {
    deliveryId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    event: {
      type: String,
      required: true,
      trim: true,
    },
    action: {
      type: String,
      default: '',
      trim: true,
    },
    provider: {
      type: String,
      enum: ['github_actions', 'jenkins'],
      default: 'github_actions',
    },
    jenkinsIntegration: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JenkinsIntegration',
      default: null,
    },
    externalRepoId: {
      type: String,
      default: '',
      trim: true,
    },
    repository: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Repository',
      default: null,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      default: null,
    },
    status: {
      type: String,
      enum: ['claimed', 'queued', 'processed', 'ignored', 'failed'],
      default: 'claimed',
    },
    jobId: {
      type: String,
      default: '',
    },
    errorMessage: {
      type: String,
      default: '',
    },
    payloadDigest: {
      type: String,
      default: '',
    },
    receivedAt: {
      type: Date,
      default: Date.now,
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

webhookDeliverySchema.index({ externalRepoId: 1, receivedAt: -1 });
webhookDeliverySchema.index({ status: 1 });

/**
 * Atomically attempts to claim a delivery ID.
 * Returns { claimed: true, delivery } if successful.
 * Returns { claimed: false, existing } if delivery was already claimed/processed.
 */
webhookDeliverySchema.statics.claimDelivery = async function ({
  deliveryId,
  event,
  action,
  externalRepoId = '',
  repositoryId = null,
  projectId = null,
  payloadDigest = '',
  provider = 'github_actions',
  jenkinsIntegrationId = null,
}) {
  try {
    const delivery = await this.create({
      deliveryId,
      event,
      action,
      provider,
      jenkinsIntegration: jenkinsIntegrationId,
      externalRepoId,
      repository: repositoryId,
      project: projectId,
      status: 'claimed',
      payloadDigest,
      receivedAt: new Date(),
    });
    return { claimed: true, delivery };
  } catch (err) {
    if (err.code === 11000 || err.message?.includes('duplicate key')) {
      const existing = await this.findOne({ deliveryId });
      return { claimed: false, existing };
    }
    throw err;
  }
};

const WebhookDelivery = mongoose.model('WebhookDelivery', webhookDeliverySchema);
export default WebhookDelivery;

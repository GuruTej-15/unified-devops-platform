import mongoose from 'mongoose';

const securityDeliverySchema = new mongoose.Schema(
  {
    integration: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SecurityIntegration',
      required: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    reportDigest: {
      type: String,
      required: true,
      trim: true,
    },
    // Scoped deterministic delivery key: `${integrationId}:${reportDigest}`
    deliveryKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['claimed', 'queued', 'processed', 'failed'],
      default: 'claimed',
    },
    jobId: {
      type: String,
      default: '',
      trim: true,
    },
    errorMessage: {
      type: String,
      default: '',
    },
    receivedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

securityDeliverySchema.index({ project: 1, receivedAt: -1 });
securityDeliverySchema.index({ integration: 1, reportDigest: 1 });
securityDeliverySchema.index({ status: 1 });

/**
 * Atomically claim a security delivery for asynchronous ingestion.
 *
 * Handles:
 * - Duplicate submissions for the same integration (returns claimed: false)
 * - Safe retry if previous attempt failed (status: 'failed' -> allows re-claim)
 * - Different integrations with the same report digest (allowed independently)
 *
 * @param {object} params
 * @param {string|mongoose.Types.ObjectId} params.integrationId
 * @param {string|mongoose.Types.ObjectId} params.projectId
 * @param {string} params.reportDigest
 * @returns {Promise<{ claimed: boolean, delivery: object, duplicate: boolean }>}
 */
securityDeliverySchema.statics.claimDelivery = async function ({
  integrationId,
  projectId,
  reportDigest,
}) {
  const deliveryKey = `${integrationId}:${reportDigest}`;

  try {
    const delivery = await this.create({
      integration: integrationId,
      project: projectId,
      reportDigest,
      deliveryKey,
      status: 'claimed',
      receivedAt: new Date(),
    });

    return { claimed: true, delivery, duplicate: false };
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key: check if the existing delivery previously failed
      const existing = await this.findOne({ deliveryKey });

      if (existing && existing.status === 'failed') {
        // Safe retry for previously failed delivery: reset status to claimed
        const reclaimed = await this.findOneAndUpdate(
          { deliveryKey, status: 'failed' },
          {
            $set: {
              status: 'claimed',
              errorMessage: '',
              receivedAt: new Date(),
            },
          },
          { new: true }
        );

        if (reclaimed) {
          return { claimed: true, delivery: reclaimed, duplicate: false };
        }
      }

      // Existing active or processed delivery: safe duplicate return
      return { claimed: false, delivery: existing, duplicate: true };
    }

    throw err;
  }
};

const SecurityDelivery = mongoose.model('SecurityDelivery', securityDeliverySchema);
export default SecurityDelivery;

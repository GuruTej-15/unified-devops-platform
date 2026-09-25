import mongoose from 'mongoose';
import {
  ORCHESTRATION_DELIVERY_STATUS,
  ORCHESTRATION_DELIVERY_STATUS_VALUES,
} from '../../shared/constants.js';

const orchestrationDeliverySchema = new mongoose.Schema(
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
    // Deterministic delivery key unique to this event/delivery across the integration
    deliveryKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ORCHESTRATION_DELIVERY_STATUS_VALUES,
      default: ORCHESTRATION_DELIVERY_STATUS.CLAIMED,
      index: true,
    },
    payloadDigest: {
      type: String,
      required: true,
      trim: true,
    },
    applicationName: {
      type: String,
      default: '',
      trim: true,
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
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

orchestrationDeliverySchema.index({ project: 1, receivedAt: -1 });
orchestrationDeliverySchema.index({ integration: 1, receivedAt: -1 });

/**
 * Atomically claim an orchestration delivery for asynchronous ingestion.
 *
 * Handles:
 * - Deterministic idempotency: duplicate deliveries return claimed: false, duplicate: true
 * - Safe retry if previous attempt failed (status: 'failed' -> allows re-claim)
 * - Authoritative database storage (no in-memory maps or caches)
 *
 * @param {object} params
 * @param {string|mongoose.Types.ObjectId} params.integrationId
 * @param {string|mongoose.Types.ObjectId} params.projectId
 * @param {string} params.deliveryKey
 * @param {string} params.payloadDigest
 * @param {string} [params.applicationName='']
 * @returns {Promise<{ claimed: boolean, delivery: object, duplicate: boolean }>}
 */
orchestrationDeliverySchema.statics.claimDelivery = async function ({
  integrationId,
  projectId,
  deliveryKey,
  payloadDigest,
  applicationName = '',
}) {
  try {
    const delivery = await this.create({
      integration: integrationId,
      project: projectId,
      deliveryKey,
      payloadDigest,
      applicationName,
      status: ORCHESTRATION_DELIVERY_STATUS.CLAIMED,
      receivedAt: new Date(),
    });

    return { claimed: true, delivery, duplicate: false };
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key: check if existing delivery previously failed
      const existing = await this.findOne({ deliveryKey });

      if (existing && existing.status === ORCHESTRATION_DELIVERY_STATUS.FAILED) {
        // Safe retry for failed delivery: reset to claimed
        const reclaimed = await this.findOneAndUpdate(
          { deliveryKey, status: ORCHESTRATION_DELIVERY_STATUS.FAILED },
          {
            $set: {
              status: ORCHESTRATION_DELIVERY_STATUS.CLAIMED,
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

const OrchestrationDelivery = mongoose.model('OrchestrationDelivery', orchestrationDeliverySchema);

export default OrchestrationDelivery;

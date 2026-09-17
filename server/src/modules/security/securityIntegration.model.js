import mongoose from 'mongoose';
import { SECURITY_PROVIDER, SECURITY_PROVIDER_VALUES } from '../../shared/constants.js';

const securityIntegrationSchema = new mongoose.Schema(
  {
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    repository: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Repository',
      default: null,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    provider: {
      type: String,
      enum: SECURITY_PROVIDER_VALUES,
      default: SECURITY_PROVIDER.TRIVY,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Encrypted ingestion token for CI webhook authentication (AES-256-GCM, select: false)
    encryptedIngestionSecret: {
      type: String,
      required: true,
      select: false,
    },
    ingestionSecretIv: {
      type: String,
      required: true,
      select: false,
    },
    ingestionSecretAuthTag: {
      type: String,
      required: true,
      select: false,
    },
    ingestionSecretHint: {
      type: String,
      default: '',
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
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

// Never serialize encrypted secret fields into JSON or Objects
securityIntegrationSchema.set('toJSON', {
  transform: function (_doc, ret) {
    delete ret.encryptedIngestionSecret;
    delete ret.ingestionSecretIv;
    delete ret.ingestionSecretAuthTag;
    return ret;
  },
});

securityIntegrationSchema.set('toObject', {
  transform: function (_doc, ret) {
    delete ret.encryptedIngestionSecret;
    delete ret.ingestionSecretIv;
    delete ret.ingestionSecretAuthTag;
    return ret;
  },
});

securityIntegrationSchema.index({ project: 1 });
securityIntegrationSchema.index({ project: 1, name: 1 }, { unique: true });

const SecurityIntegration = mongoose.model('SecurityIntegration', securityIntegrationSchema);
export default SecurityIntegration;

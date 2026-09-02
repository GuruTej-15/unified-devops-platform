import mongoose from 'mongoose';
import { CONNECTION_STATUS, SYNC_STATUS, VCS_PROVIDER } from '../../shared/constants.js';

const repositorySchema = new mongoose.Schema(
  {
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    provider: {
      type: String,
      enum: Object.values(VCS_PROVIDER),
      default: VCS_PROVIDER.GITHUB,
      required: true,
    },
    externalId: {
      type: String,
      required: true,
    },
    owner: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    defaultBranch: {
      type: String,
      default: 'main',
    },
    htmlUrl: {
      type: String,
      required: true,
    },
    isPrivate: {
      type: Boolean,
      default: false,
    },
    language: String,
    starCount: {
      type: Number,
      default: 0,
    },
    description: {
      type: String,
      default: '',
    },

    // Connection & sync metadata
    connectionStatus: {
      type: String,
      enum: Object.values(CONNECTION_STATUS),
      default: CONNECTION_STATUS.CONNECTED,
    },
    lastSyncedAt: Date,
    lastSuccessfulSyncAt: Date,
    lastSyncStatus: {
      type: String,
      enum: Object.values(SYNC_STATUS),
    },
    lastSyncError: String,
    connectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Encrypted GitHub PAT — NEVER return these fields in API responses
    encryptedToken: {
      type: String,
      required: true,
      select: false,
    },
    tokenIv: {
      type: String,
      required: true,
      select: false,
    },
    tokenAuthTag: {
      type: String,
      required: true,
      select: false,
    },
    tokenHint: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Never serialize encrypted PAT fields into JSON or Objects
repositorySchema.set('toJSON', {
  transform: function (_doc, ret) {
    delete ret.encryptedToken;
    delete ret.tokenIv;
    delete ret.tokenAuthTag;
    return ret;
  },
});

repositorySchema.set('toObject', {
  transform: function (_doc, ret) {
    delete ret.encryptedToken;
    delete ret.tokenIv;
    delete ret.tokenAuthTag;
    return ret;
  },
});

repositorySchema.index({ project: 1 });
repositorySchema.index({ project: 1, fullName: 1 }, { unique: true });
repositorySchema.index({ externalId: 1, provider: 1 });

const Repository = mongoose.model('Repository', repositorySchema);
export default Repository;

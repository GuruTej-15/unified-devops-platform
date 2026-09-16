import mongoose from 'mongoose';

const jenkinsIntegrationSchema = new mongoose.Schema(
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
    jobName: {
      type: String,
      required: true,
      trim: true,
    },
    serverUrl: {
      type: String,
      required: true,
      trim: true,
    },
    username: {
      type: String,
      default: '',
      trim: true,
    },
    // Encrypted API token for outbound reconciliation (select: false)
    encryptedApiToken: {
      type: String,
      select: false,
    },
    apiTokenIv: {
      type: String,
      select: false,
    },
    apiTokenAuthTag: {
      type: String,
      select: false,
    },
    apiTokenHint: {
      type: String,
      default: '',
    },
    // Encrypted webhook secret for inbound verification (select: false)
    encryptedWebhookSecret: {
      type: String,
      required: true,
      select: false,
    },
    webhookSecretIv: {
      type: String,
      required: true,
      select: false,
    },
    webhookSecretAuthTag: {
      type: String,
      required: true,
      select: false,
    },
    webhookSecretHint: {
      type: String,
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastSyncedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

jenkinsIntegrationSchema.index({ project: 1 });
jenkinsIntegrationSchema.index({ repository: 1, jobName: 1 });

const JenkinsIntegration = mongoose.model('JenkinsIntegration', jenkinsIntegrationSchema);
export default JenkinsIntegration;

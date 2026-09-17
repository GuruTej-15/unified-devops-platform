import mongoose from 'mongoose';
import {
  SECURITY_PROVIDER,
  SECURITY_PROVIDER_VALUES,
  SECURITY_SCAN_STATUS,
  SECURITY_SCAN_STATUS_VALUES,
  SECURITY_SCAN_TYPE,
  SECURITY_SCAN_TYPE_VALUES,
  POLICY_EVALUATION_STATE_VALUES,
} from '../../shared/constants.js';

const securityScanSchema = new mongoose.Schema(
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
    pipelineRun: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PipelineRun',
      default: null,
    },
    securityIntegration: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SecurityIntegration',
      default: null,
    },
    provider: {
      type: String,
      enum: SECURITY_PROVIDER_VALUES,
      default: SECURITY_PROVIDER.TRIVY,
      required: true,
    },
    scanType: {
      type: String,
      enum: SECURITY_SCAN_TYPE_VALUES,
      default: SECURITY_SCAN_TYPE.FILESYSTEM,
      required: true,
    },
    target: {
      type: String,
      required: true,
      trim: true,
    },
    commitSha: {
      type: String,
      default: '',
      trim: true,
    },
    branch: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: SECURITY_SCAN_STATUS_VALUES,
      default: SECURITY_SCAN_STATUS.PENDING,
      required: true,
    },
    // SHA-256 digest of incoming raw report for submission deduplication (NOT globally unique)
    reportDigest: {
      type: String,
      required: true,
      trim: true,
    },
    summary: {
      critical: { type: Number, default: 0 },
      high: { type: Number, default: 0 },
      medium: { type: Number, default: 0 },
      low: { type: Number, default: 0 },
      negligible: { type: Number, default: 0 },
      unknown: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    findingCount: {
      type: Number,
      default: 0,
    },
    providerMetadata: {
      schemaVersion: { type: Number, default: 2 },
      trivyVersion: { type: String, default: '', trim: true },
      artifactName: { type: String, default: '', trim: true },
      artifactType: { type: String, default: '', trim: true },
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    duration: {
      type: Number, // In seconds
      default: null,
    },
    errorMessage: {
      type: String,
      default: '',
    },
    gateStatus: {
      type: String,
      enum: [...POLICY_EVALUATION_STATE_VALUES, null],
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

securityScanSchema.index({ project: 1, createdAt: -1 });
securityScanSchema.index({ repository: 1, commitSha: 1 });
securityScanSchema.index({ pipelineRun: 1 });
securityScanSchema.index({ securityIntegration: 1 });
securityScanSchema.index({ reportDigest: 1 });
securityScanSchema.index({ project: 1, target: 1, status: 1 });

const SecurityScan = mongoose.model('SecurityScan', securityScanSchema);
export default SecurityScan;

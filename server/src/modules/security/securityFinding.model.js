import mongoose from 'mongoose';
import {
  SECURITY_PROVIDER,
  SECURITY_PROVIDER_VALUES,
  SECURITY_SEVERITY_VALUES,
  SECURITY_FINDING_TYPE,
  SECURITY_FINDING_TYPE_VALUES,
  SECURITY_FINDING_STATUS,
  SECURITY_FINDING_STATUS_VALUES,
} from '../../shared/constants.js';

const securityFindingSchema = new mongoose.Schema(
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
    scan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SecurityScan',
      required: true,
    },
    provider: {
      type: String,
      enum: SECURITY_PROVIDER_VALUES,
      default: SECURITY_PROVIDER.TRIVY,
      required: true,
    },
    // Stable identity key for lifecycle reconciliation across scans (MUST NOT be unique)
    findingIdentityKey: {
      type: String,
      required: true,
      trim: true,
    },
    vulnerabilityId: {
      type: String,
      required: true,
      trim: true,
    },
    title: {
      type: String,
      default: '',
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    severity: {
      type: String,
      enum: SECURITY_SEVERITY_VALUES,
      required: true,
    },
    pkgName: {
      type: String,
      required: true,
      trim: true,
    },
    // Installed package version (NOT part of findingIdentityKey)
    installedVersion: {
      type: String,
      default: '',
      trim: true,
    },
    fixedVersion: {
      type: String,
      default: '',
      trim: true,
    },
    target: {
      type: String,
      required: true,
      trim: true,
    },
    findingType: {
      type: String,
      enum: SECURITY_FINDING_TYPE_VALUES,
      default: SECURITY_FINDING_TYPE.VULNERABILITY,
    },
    status: {
      type: String,
      enum: SECURITY_FINDING_STATUS_VALUES,
      default: SECURITY_FINDING_STATUS.OPEN,
      required: true,
    },
    acknowledgedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    acknowledgedAt: {
      type: Date,
      default: null,
    },
    acknowledgeNote: {
      type: String,
      default: '',
      trim: true,
    },
    primaryUrl: {
      type: String,
      default: '',
      trim: true,
    },
    references: {
      type: [String],
      default: [],
    },
    firstDetectedAt: {
      type: Date,
      default: Date.now,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Query indexes — CRITICAL: findingIdentityKey is NOT unique!
securityFindingSchema.index({ scan: 1 });
securityFindingSchema.index({ project: 1, status: 1, severity: 1 });
securityFindingSchema.index({ project: 1, findingIdentityKey: 1 });
securityFindingSchema.index({ repository: 1, target: 1, status: 1 });

const SecurityFinding = mongoose.model('SecurityFinding', securityFindingSchema);
export default SecurityFinding;

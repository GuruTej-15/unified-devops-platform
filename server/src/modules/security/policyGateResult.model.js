import mongoose from 'mongoose';
import {
  POLICY_RULE_TYPE_VALUES,
  POLICY_ENFORCEMENT_VALUES,
  POLICY_EVALUATION_STATE_VALUES,
} from '../../shared/constants.js';

const policyGateResultSchema = new mongoose.Schema(
  {
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    scan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SecurityScan',
      required: true,
    },
    pipelineRun: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PipelineRun',
      default: null,
    },
    policy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GovernancePolicy',
      required: true,
    },
    policyName: {
      type: String,
      required: true,
      trim: true,
    },
    ruleType: {
      type: String,
      enum: POLICY_RULE_TYPE_VALUES,
      required: true,
    },
    enforcement: {
      type: String,
      enum: POLICY_ENFORCEMENT_VALUES,
      required: true,
    },
    // CRITICAL: Original evaluation outcome remains immutable even when overridden
    passed: {
      type: Boolean,
      required: true,
    },
    evaluationStatus: {
      type: String,
      enum: POLICY_EVALUATION_STATE_VALUES,
      required: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    evaluatedData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Non-destructive Manual Override fields
    isOverridden: {
      type: Boolean,
      default: false,
    },
    overrideStatus: {
      type: String,
      enum: ['approved', null],
      default: null,
    },
    overriddenBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    overriddenAt: {
      type: Date,
      default: null,
    },
    overrideJustification: {
      type: String,
      default: '',
      trim: true,
    },
    originalGateState: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

policyGateResultSchema.index({ scan: 1, policy: 1 }, { unique: true });
policyGateResultSchema.index({ project: 1, createdAt: -1 });
policyGateResultSchema.index({ pipelineRun: 1 });

const PolicyGateResult = mongoose.model('PolicyGateResult', policyGateResultSchema);
export default PolicyGateResult;

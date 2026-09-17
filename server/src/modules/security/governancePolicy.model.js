import mongoose from 'mongoose';
import {
  POLICY_RULE_TYPE,
  POLICY_RULE_TYPE_VALUES,
  POLICY_ENFORCEMENT,
  POLICY_ENFORCEMENT_VALUES,
  SECURITY_SEVERITY_VALUES,
  SECURITY_SCAN_TYPE_VALUES,
} from '../../shared/constants.js';

const governancePolicySchema = new mongoose.Schema(
  {
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    ruleType: {
      type: String,
      enum: POLICY_RULE_TYPE_VALUES,
      required: true,
    },
    ruleConfig: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      validate: {
        validator: function (val) {
          if (!val || typeof val !== 'object' || Array.isArray(val)) {
            return false;
          }
          if (this.ruleType === POLICY_RULE_TYPE.MAX_SEVERITY_COUNT) {
            return (
              typeof val.maxCount === 'number' &&
              val.maxCount >= 0 &&
              SECURITY_SEVERITY_VALUES.includes(val.severity)
            );
          }
          if (this.ruleType === POLICY_RULE_TYPE.REQUIRED_SCAN) {
            return (
              typeof val.maxAgeSeconds === 'number' &&
              val.maxAgeSeconds > 0 &&
              SECURITY_SCAN_TYPE_VALUES.includes(val.scanType)
            );
          }
          return true;
        },
        message: (props) => `Invalid ruleConfig for ruleType: ${JSON.stringify(props.value)}`,
      },
    },
    enforcement: {
      type: String,
      enum: POLICY_ENFORCEMENT_VALUES,
      default: POLICY_ENFORCEMENT.BLOCKING,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
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

governancePolicySchema.index({ project: 1, isActive: 1 });
governancePolicySchema.index({ project: 1, name: 1 }, { unique: true });

const GovernancePolicy = mongoose.model('GovernancePolicy', governancePolicySchema);
export default GovernancePolicy;

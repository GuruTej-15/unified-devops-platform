import mongoose from 'mongoose';
import {
  ISSUE_STATUS_VALUES,
  ISSUE_PRIORITY_VALUES,
  ISSUE_TYPE_VALUES,
} from '../../shared/constants.js';

const issueSchema = new mongoose.Schema(
  {
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    issueKey: {
      type: String,
      required: true,
      unique: true,
    },
    issueNumber: {
      type: Number,
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 500,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ISSUE_STATUS_VALUES,
      default: 'open',
    },
    priority: {
      type: String,
      enum: ISSUE_PRIORITY_VALUES,
      default: 'medium',
    },
    type: {
      type: String,
      enum: ISSUE_TYPE_VALUES,
      default: 'task',
    },
    assignee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reporter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    labels: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

issueSchema.index({ project: 1, issueNumber: 1 }, { unique: true });
issueSchema.index({ project: 1, status: 1 });
issueSchema.index({ assignee: 1, status: 1 });
issueSchema.index({ project: 1, createdAt: -1 });

export const Issue = mongoose.model('Issue', issueSchema);
export default Issue;

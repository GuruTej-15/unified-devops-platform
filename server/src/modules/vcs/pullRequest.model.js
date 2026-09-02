import mongoose from 'mongoose';
import { PR_STATE } from '../../shared/constants.js';

const pullRequestSchema = new mongoose.Schema(
  {
    repository: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Repository',
      required: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    number: {
      type: Number,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      default: '',
    },
    state: {
      type: String,
      enum: Object.values(PR_STATE),
      default: PR_STATE.OPEN,
    },
    authorLogin: String,
    authorAvatar: String,
    sourceBranch: String,
    targetBranch: String,
    url: String,
    // Candidate issue keys from title, body, and branch name
    matchedIssueKeys: {
      type: [String],
      default: [],
    },
    mergedAt: Date,
  },
  {
    timestamps: true,
  }
);

pullRequestSchema.index({ repository: 1, number: 1 }, { unique: true });
pullRequestSchema.index({ project: 1, updatedAt: -1 });
pullRequestSchema.index({ matchedIssueKeys: 1 });

const PullRequest = mongoose.model('PullRequest', pullRequestSchema);
export default PullRequest;

import mongoose from 'mongoose';

const commitSchema = new mongoose.Schema(
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
    sha: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    authorName: String,
    authorEmail: String,
    authorAvatar: String,
    authoredAt: {
      type: Date,
      required: true,
    },
    url: String,
    // Candidate issue keys extracted from commit message — NOT verified foreign keys
    matchedIssueKeys: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

commitSchema.index({ repository: 1, sha: 1 }, { unique: true });
commitSchema.index({ project: 1, authoredAt: -1 });
commitSchema.index({ matchedIssueKeys: 1 });

const Commit = mongoose.model('Commit', commitSchema);
export default Commit;

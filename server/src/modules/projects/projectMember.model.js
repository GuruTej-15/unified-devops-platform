import mongoose from 'mongoose';
import { PROJECT_MEMBER_ROLE_VALUES } from '../../shared/constants.js';

const projectMemberSchema = new mongoose.Schema({
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  role: {
    type: String,
    enum: PROJECT_MEMBER_ROLE_VALUES,
    default: 'developer',
  },
  joinedAt: {
    type: Date,
    default: Date.now,
  },
});

projectMemberSchema.index({ project: 1, user: 1 }, { unique: true });
projectMemberSchema.index({ user: 1 });

const ProjectMember = mongoose.model('ProjectMember', projectMemberSchema);

export default ProjectMember;

import mongoose from 'mongoose';
import { INITIAL_ISSUE_COUNTER } from '../../shared/constants.js';

const projectCounterSchema = new mongoose.Schema({
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    unique: true,
  },
  currentSeq: {
    type: Number,
    default: INITIAL_ISSUE_COUNTER || 100,
  },
});

projectCounterSchema.statics.getNextSequence = async function (projectId) {
  const counter = await this.findOneAndUpdate(
    { project: projectId },
    { $inc: { currentSeq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return counter.currentSeq;
};

const ProjectCounter = mongoose.model('ProjectCounter', projectCounterSchema);

export default ProjectCounter;

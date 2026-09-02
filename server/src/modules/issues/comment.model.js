import mongoose from 'mongoose';

const commentSchema = new mongoose.Schema(
  {
    issue: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Issue',
      required: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 10000,
    },
  },
  {
    timestamps: true,
  }
);

commentSchema.index({ issue: 1, createdAt: 1 });

export const Comment = mongoose.model('Comment', commentSchema);
export default Comment;

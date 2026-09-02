import { useState, useEffect } from 'react';
import api from '../../../lib/axios.js';
import Avatar from '../../../components/ui/Avatar.jsx';
import Button from '../../../components/ui/Button.jsx';
import { formatTimeAgo } from '../../../lib/utils.js';

export default function CommentSection({ projectId, issueKey }) {
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const fetchComments = async () => {
    try {
      const res = await api.get(`/projects/${projectId}/issues/${issueKey}/comments`);
      setComments(res.data || []);
    } catch (err) {
      console.error('Failed to load comments', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectId && issueKey) {
      fetchComments();
    }
  }, [projectId, issueKey]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    setSubmitting(true);
    try {
      await api.post(`/projects/${projectId}/issues/${issueKey}/comments`, {
        body: newComment.trim(),
      });
      setNewComment('');
      fetchComments();
    } catch (err) {
      alert(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <h3 className="text-base font-bold text-gray-900 flex items-center space-x-2">
        <span>Activity & Discussion</span>
        <span className="text-xs font-semibold px-2 py-0.5 bg-gray-100 rounded-full text-gray-600">
          {comments.length}
        </span>
      </h3>

      {/* New Comment Input */}
      <form onSubmit={handleSubmit} className="space-y-3">
        <textarea
          rows={3}
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="Leave a comment, implementation notes, or delivery update..."
          className="w-full rounded-xl border border-gray-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 shadow-2xs"
          required
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={submitting} disabled={!newComment.trim()}>
            Post Comment
          </Button>
        </div>
      </form>

      {/* Comment Stream */}
      <div className="space-y-4 pt-2">
        {comments.map((comment) => (
          <div
            key={comment._id}
            className="flex space-x-3 p-4 bg-gray-50/70 rounded-xl border border-gray-100"
          >
            <Avatar user={comment.author} size="md" />
            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-gray-900">
                  {comment.author
                    ? `${comment.author.firstName || ''} ${comment.author.lastName || ''}`.trim() ||
                      comment.author.username
                    : 'Unknown'}
                </span>
                <span className="text-gray-400">{formatTimeAgo(comment.createdAt)}</span>
              </div>
              <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                {comment.body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

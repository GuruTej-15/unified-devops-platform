import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router';
import api from '../../lib/axios.js';
import Card from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import Avatar from '../../components/ui/Avatar.jsx';
import { StatusBadge, PriorityBadge, TypeBadge } from './components/IssueStatusBadge.jsx';
import DeliveryStateTracker from './components/DeliveryStateTracker.jsx';
import CommentSection from './components/CommentSection.jsx';
import LoadingSpinner from '../../components/ui/LoadingSpinner.jsx';
import { formatDate } from '../../lib/utils.js';

export default function IssueDetailPage() {
  const { projectId, issueKey } = useParams();

  const [issue, setIssue] = useState(null);
  const [activity, setActivity] = useState({ commits: [], pullRequests: [], branches: [] });
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');

  const fetchIssueData = async () => {
    try {
      setLoading(true);
      const [issueRes, activityRes] = await Promise.all([
        api.get(`/projects/${projectId}/issues/${issueKey}`),
        api.get(`/projects/${projectId}/issues/${issueKey}/activity`),
      ]);
      setIssue(issueRes.data);
      setStatus(issueRes.data.status);
      setPriority(issueRes.data.priority);
      setActivity(activityRes.data || {});
    } catch (err) {
      console.error('Failed to load issue details', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectId && issueKey) {
      fetchIssueData();
    }
  }, [projectId, issueKey]);

  const handleUpdateStatus = async (newStatus) => {
    try {
      const res = await api.put(`/projects/${projectId}/issues/${issueKey}`, { status: newStatus });
      setIssue(res.data);
      setStatus(newStatus);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleUpdatePriority = async (newPriority) => {
    try {
      const res = await api.put(`/projects/${projectId}/issues/${issueKey}`, {
        priority: newPriority,
      });
      setIssue(res.data);
      setPriority(newPriority);
    } catch (err) {
      alert(err.message);
    }
  };

  if (loading) {
    return <LoadingSpinner size="lg" label={`Loading ${issueKey}...`} />;
  }

  if (!issue) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-bold text-gray-900">Issue not found</h2>
        <Link to={`/projects/${projectId}/issues`} className="mt-4 inline-block text-primary-600">
          Back to issues
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb & Top Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2 text-xs text-gray-500 mb-1">
            <Link to={`/projects/${projectId}/issues`} className="hover:text-gray-900">
              Issues
            </Link>
            <span>/</span>
            <span className="font-mono font-bold text-gray-800">{issue.issueKey}</span>
          </div>
          <div className="flex items-center space-x-3">
            <h1 className="text-2xl font-bold text-gray-900">{issue.title}</h1>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <select
            value={status}
            onChange={(e) => handleUpdateStatus(e.target.value)}
            className="text-xs font-semibold uppercase tracking-wider border border-gray-300 rounded-lg px-3 py-2 bg-white shadow-2xs focus:ring-2 focus:ring-primary-500"
          >
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="in_review">In Review</option>
            <option value="done">Done</option>
            <option value="closed">Closed</option>
          </select>
        </div>
      </div>

      {/* Main Grid: Left = Details & Discussion, Right = Delivery State & Attributes */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Description & Comments */}
        <div className="lg:col-span-2 space-y-6">
          <Card title="Description">
            {issue.description ? (
              <div className="prose prose-sm max-w-none text-gray-800 whitespace-pre-wrap leading-relaxed">
                {issue.description}
              </div>
            ) : (
              <p className="text-sm text-gray-400 italic">
                No description provided for this issue.
              </p>
            )}

            {issue.labels?.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-100 flex flex-wrap gap-1.5">
                {issue.labels.map((lbl) => (
                  <span
                    key={lbl}
                    className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-md font-medium"
                  >
                    #{lbl}
                  </span>
                ))}
              </div>
            )}
          </Card>

          {/* Comment Stream */}
          <Card>
            <CommentSection projectId={projectId} issueKey={issueKey} />
          </Card>
        </div>

        {/* Right Column: Unified Delivery State Tracker & Metadata */}
        <div className="space-y-6">
          {/* Unified Delivery State Tracker */}
          <DeliveryStateTracker issue={issue} activity={activity} />

          {/* Issue Attributes */}
          <Card title="Attributes">
            <dl className="space-y-3 text-xs">
              <div className="flex justify-between py-1 border-b border-gray-50">
                <dt className="text-gray-500 font-medium">Type</dt>
                <dd>
                  <TypeBadge type={issue.type} />
                </dd>
              </div>

              <div className="flex justify-between py-1 border-b border-gray-50 items-center">
                <dt className="text-gray-500 font-medium">Priority</dt>
                <dd>
                  <select
                    value={priority}
                    onChange={(e) => handleUpdatePriority(e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-0.5 bg-white font-medium capitalize"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </dd>
              </div>

              <div className="flex justify-between py-1 border-b border-gray-50 items-center">
                <dt className="text-gray-500 font-medium">Assignee</dt>
                <dd className="flex items-center space-x-1.5">
                  <Avatar user={issue.assignee} size="sm" />
                  <span className="font-semibold text-gray-900">
                    {issue.assignee
                      ? `${issue.assignee.firstName || ''} ${issue.assignee.lastName || ''}`.trim() ||
                        issue.assignee.username
                      : 'Unassigned'}
                  </span>
                </dd>
              </div>

              <div className="flex justify-between py-1 border-b border-gray-50 items-center">
                <dt className="text-gray-500 font-medium">Reporter</dt>
                <dd className="flex items-center space-x-1.5">
                  <Avatar user={issue.reporter} size="sm" />
                  <span className="text-gray-700">
                    {issue.reporter
                      ? `${issue.reporter.firstName || ''} ${issue.reporter.lastName || ''}`.trim() ||
                        issue.reporter.username
                      : 'User'}
                  </span>
                </dd>
              </div>

              <div className="flex justify-between py-1">
                <dt className="text-gray-500 font-medium">Created</dt>
                <dd className="text-gray-700">{formatDate(issue.createdAt)}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}

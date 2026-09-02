import { useState, useEffect } from 'react';
import { useOutletContext, Link, useParams } from 'react-router';
import api from '../../lib/axios.js';
import IssueCard from './components/IssueCard.jsx';
import Button from '../../components/ui/Button.jsx';
import Input from '../../components/ui/Input.jsx';
import Select from '../../components/ui/Select.jsx';
import LoadingSpinner from '../../components/ui/LoadingSpinner.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import { PlusIcon, DocumentCheckIcon } from '@heroicons/react/24/outline';
import { getSocket } from '../../lib/socket.js';

export default function IssueListPage() {
  const { projectId } = useParams();
  const { project } = useOutletContext();

  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    search: '',
    status: '',
    priority: '',
    type: '',
  });

  const fetchIssues = async () => {
    try {
      setLoading(true);
      const params = {};
      if (filters.search) params.search = filters.search;
      if (filters.status) params.status = filters.status;
      if (filters.priority) params.priority = filters.priority;
      if (filters.type) params.type = filters.type;

      const res = await api.get(`/projects/${projectId}/issues`, { params });
      setIssues(res.data || []);
    } catch (err) {
      console.error('Failed to load issues', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetchIssues();
    }
  }, [projectId, filters.status, filters.priority, filters.type]);

  // Real-time socket listener for issue events
  useEffect(() => {
    const socket = getSocket();
    const handleIssueChange = () => {
      fetchIssues();
    };

    socket.on('issue.created', handleIssueChange);
    socket.on('issue.updated', handleIssueChange);
    socket.on('issue.status.changed', handleIssueChange);
    socket.on('issue.deleted', handleIssueChange);

    return () => {
      socket.off('issue.created', handleIssueChange);
      socket.off('issue.updated', handleIssueChange);
      socket.off('issue.status.changed', handleIssueChange);
      socket.off('issue.deleted', handleIssueChange);
    };
  }, [projectId]);

  const statusOptions = [
    { value: '', label: 'All Statuses' },
    { value: 'open', label: 'Open' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'in_review', label: 'In Review' },
    { value: 'done', label: 'Done' },
    { value: 'closed', label: 'Closed' },
  ];

  const priorityOptions = [
    { value: '', label: 'All Priorities' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'critical', label: 'Critical' },
  ];

  const typeOptions = [
    { value: '', label: 'All Types' },
    { value: 'task', label: 'Task' },
    { value: 'bug', label: 'Bug' },
    { value: 'feature', label: 'Feature' },
    { value: 'improvement', label: 'Improvement' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Issues & Tasks</h1>
          <p className="text-sm text-gray-500 mt-1">
            Track requirements, features, and bugs connected to code changes
          </p>
        </div>
        <Link to={`/projects/${projectId}/issues/new`}>
          <Button size="md">
            <PlusIcon className="w-4 h-4 mr-2" />
            Create Issue
          </Button>
        </Link>
      </div>

      {/* Filters Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 bg-white p-4 rounded-xl border border-gray-200/80 shadow-2xs">
        <Input
          placeholder="Search by title..."
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && fetchIssues()}
        />
        <Select
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          options={statusOptions}
        />
        <Select
          value={filters.priority}
          onChange={(e) => setFilters({ ...filters, priority: e.target.value })}
          options={priorityOptions}
        />
        <Select
          value={filters.type}
          onChange={(e) => setFilters({ ...filters, type: e.target.value })}
          options={typeOptions}
        />
      </div>

      {/* Issue Cards Grid */}
      {loading ? (
        <LoadingSpinner size="lg" label="Loading issues..." />
      ) : issues.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {issues.map((issue) => (
            <IssueCard key={issue._id} issue={issue} projectId={projectId} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={DocumentCheckIcon}
          title="No issues found"
          description="Create a task or bug to start tracking work and linking commits"
          actionLabel="Create Issue"
          onAction={() => window.location.assign(`/projects/${projectId}/issues/new`)}
        />
      )}
    </div>
  );
}

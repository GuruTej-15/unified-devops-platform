import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import api from '../../lib/axios.js';
import Card from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import Input from '../../components/ui/Input.jsx';
import Select from '../../components/ui/Select.jsx';

export default function IssueCreatePage() {
  const { projectId } = useParams();
  const navigate = useNavigate();

  const [members, setMembers] = useState([]);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    type: 'task',
    priority: 'medium',
    assignee: '',
    labels: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (projectId) {
      api
        .get(`/projects/${projectId}/members`)
        .then((res) => setMembers(res.data || []))
        .catch((err) => console.error('Failed to load project members', err));
    }
  }, [projectId]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const payload = {
        title: formData.title.trim(),
        description: formData.description.trim(),
        type: formData.type,
        priority: formData.priority,
        assignee: formData.assignee || undefined,
        labels: formData.labels
          ? formData.labels
              .split(',')
              .map((l) => l.trim())
              .filter(Boolean)
          : [],
      };

      const res = await api.post(`/projects/${projectId}/issues`, payload);
      navigate(`/projects/${projectId}/issues/${res.data.issueKey}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const typeOptions = [
    { value: 'task', label: 'Task' },
    { value: 'bug', label: 'Bug' },
    { value: 'feature', label: 'Feature' },
    { value: 'improvement', label: 'Improvement' },
  ];

  const priorityOptions = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'critical', label: 'Critical' },
  ];

  const assigneeOptions = [
    { value: '', label: 'Unassigned' },
    ...members.map((m) => ({
      value: m.user?._id,
      label: `${m.user?.firstName || ''} ${m.user?.lastName || ''} (@${m.user?.username})`.trim(),
    })),
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <div className="flex items-center space-x-2 text-sm text-gray-500 mb-1">
          <Link to={`/projects/${projectId}/issues`} className="hover:text-gray-900">
            Issues
          </Link>
          <span>/</span>
          <span>New</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Create New Issue</h1>
        <p className="text-sm text-gray-500 mt-1">
          Define delivery requirements and work items for your team
        </p>
      </div>

      <Card>
        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Issue Title"
            required
            placeholder="e.g. Add payment validation"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Select
              label="Type"
              value={formData.type}
              onChange={(e) => setFormData({ ...formData, type: e.target.value })}
              options={typeOptions}
            />
            <Select
              label="Priority"
              value={formData.priority}
              onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
              options={priorityOptions}
            />
            <Select
              label="Assignee"
              value={formData.assignee}
              onChange={(e) => setFormData({ ...formData, assignee: e.target.value })}
              options={assigneeOptions}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description (Markdown supported)
            </label>
            <textarea
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-primary-500"
              rows={6}
              placeholder="Describe requirements, acceptance criteria, reproduction steps..."
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            />
          </div>

          <Input
            label="Labels (Comma-separated)"
            placeholder="backend, api, payments, security"
            value={formData.labels}
            onChange={(e) => setFormData({ ...formData, labels: e.target.value })}
          />

          <div className="flex items-center justify-end space-x-3 pt-4 border-t border-gray-100">
            <Link to={`/projects/${projectId}/issues`}>
              <Button variant="secondary">Cancel</Button>
            </Link>
            <Button type="submit" loading={loading}>
              Create Issue
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

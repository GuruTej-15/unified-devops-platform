import { useState } from 'react';
import { useOutletContext, useNavigate } from 'react-router';
import api from '../../lib/axios.js';
import Card from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import Input from '../../components/ui/Input.jsx';
import MembersList from './components/MembersList.jsx';

export default function ProjectSettingsPage() {
  const { project, setProject } = useOutletContext();
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    name: project?.name || '',
    description: project?.description || '',
  });

  const [loading, setLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState(null);
  const [error, setError] = useState(null);

  const handleUpdate = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await api.put(`/projects/${project._id}`, formData);
      setProject(res.data);
      setSuccessMessage('Project updated successfully');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleArchive = async () => {
    if (!window.confirm('Are you sure you want to archive this project?')) return;

    try {
      await api.patch(`/projects/${project._id}/archive`);
      navigate('/projects');
    } catch (err) {
      alert(err.message);
    }
  };

  if (!project) return null;

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Project Settings</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage project configuration, team members, and lifecycle
        </p>
      </div>

      {/* General Settings */}
      <Card title="General Configuration">
        {successMessage && (
          <div className="mb-4 p-3 bg-emerald-50 text-emerald-700 text-sm rounded-lg border border-emerald-200">
            {successMessage}
          </div>
        )}
        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
            {error}
          </div>
        )}

        <form onSubmit={handleUpdate} className="space-y-4">
          <Input
            label="Project Name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Project Key (Immutable)
            </label>
            <input
              type="text"
              disabled
              value={project.key}
              className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500 font-mono"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-primary-500"
              rows={3}
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            />
          </div>

          <div className="flex justify-end pt-2">
            <Button type="submit" loading={loading}>
              Save Changes
            </Button>
          </div>
        </form>
      </Card>

      {/* Members Section */}
      <Card>
        <MembersList projectId={project._id} />
      </Card>

      {/* Danger Zone */}
      <Card title="Danger Zone" className="border-red-200 bg-red-50/20">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">Archive Project</h4>
            <p className="text-xs text-gray-500 mt-0.5">
              Archiving makes the project read-only and hides it from primary active project views.
            </p>
          </div>
          <Button variant="danger" size="sm" onClick={handleArchive}>
            Archive Project
          </Button>
        </div>
      </Card>
    </div>
  );
}

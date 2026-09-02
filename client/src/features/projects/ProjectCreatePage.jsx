import { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import api from '../../lib/axios.js';
import Card from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import Input from '../../components/ui/Input.jsx';

export default function ProjectCreatePage() {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    name: '',
    key: '',
    description: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleNameChange = (e) => {
    const name = e.target.value;
    // Auto-generate candidate 3-letter key from name if key hasn't been manually typed
    const words = name.trim().split(/\s+/);
    let autoKey = '';
    if (words.length >= 2) {
      autoKey = (words[0][0] + words[1][0] + (words[2]?.[0] || words[1][1] || 'X')).toUpperCase();
    } else if (name.length >= 3) {
      autoKey = name.substring(0, 3).toUpperCase();
    }

    setFormData((prev) => ({
      ...prev,
      name,
      key: prev.key === '' || prev.key.length <= 3 ? autoKey.slice(0, 5) : prev.key,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await api.post('/projects', formData);
      navigate(`/projects/${res.data._id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <div className="flex items-center space-x-2 text-sm text-gray-500 mb-1">
          <Link to="/projects" className="hover:text-gray-900">
            Projects
          </Link>
          <span>/</span>
          <span>New</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Create New Project</h1>
        <p className="text-sm text-gray-500 mt-1">
          Establish a new delivery workspace with issue tracking and repository integration
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
            label="Project Name"
            required
            placeholder="e.g. Payment Service"
            value={formData.name}
            onChange={handleNameChange}
          />

          <Input
            label="Project Key"
            required
            placeholder="e.g. PAY"
            value={formData.key}
            onChange={(e) =>
              setFormData({
                ...formData,
                key: e.target.value
                  .toUpperCase()
                  .replace(/[^A-Z]/g, '')
                  .slice(0, 5),
              })
            }
            helperText="2-5 uppercase letters. Used as prefix for issue identifiers (e.g. PAY-101)."
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description (Optional)
            </label>
            <textarea
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              rows={4}
              placeholder="Briefly describe the purpose of this project..."
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            />
          </div>

          <div className="flex items-center justify-end space-x-3 pt-4 border-t border-gray-100">
            <Link to="/projects">
              <Button variant="secondary">Cancel</Button>
            </Link>
            <Button type="submit" loading={loading}>
              Create Project
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

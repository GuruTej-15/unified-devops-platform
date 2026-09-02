import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import api from '../../lib/axios.js';
import ProjectCard from './components/ProjectCard.jsx';
import Button from '../../components/ui/Button.jsx';
import Input from '../../components/ui/Input.jsx';
import LoadingSpinner from '../../components/ui/LoadingSpinner.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import { PlusIcon, FolderIcon } from '@heroicons/react/24/outline';

export default function ProjectListPage() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const res = await api.get('/projects');
      setProjects(res.data || []);
    } catch (err) {
      console.error('Failed to load projects', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const filteredProjects = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.key.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Projects</h1>
          <p className="text-sm text-gray-500 mt-1">
            DevOps delivery workspaces and integrated toolchain contexts
          </p>
        </div>
        <Link to="/projects/new">
          <Button size="md">
            <PlusIcon className="w-4 h-4 mr-2" />
            Create Project
          </Button>
        </Link>
      </div>

      {/* Filter and Search */}
      <div className="flex items-center space-x-4 max-w-md">
        <Input
          placeholder="Filter by name or key (e.g. PAY)..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Project Grid */}
      {loading ? (
        <LoadingSpinner size="lg" label="Loading projects..." />
      ) : filteredProjects.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredProjects.map((project) => (
            <ProjectCard key={project._id} project={project} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={FolderIcon}
          title={search ? 'No matching projects found' : 'No projects yet'}
          description={
            search
              ? 'Try adjusting your search terms'
              : 'Create your first project to start unifying issues, commits, and pipelines'
          }
          actionLabel={search ? undefined : 'Create Project'}
          onAction={search ? undefined : () => window.location.assign('/projects/new')}
        />
      )}
    </div>
  );
}

import { Link } from 'react-router';
import Badge from '../../../components/ui/Badge.jsx';
import Avatar from '../../../components/ui/Avatar.jsx';
import { formatDate } from '../../../lib/utils.js';
import { ArrowRightIcon } from '@heroicons/react/24/outline';

export default function ProjectCard({ project }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200/80 p-5 shadow-xs hover:shadow-md hover:border-primary-300 transition-all flex flex-col justify-between group">
      <div>
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-2">
            <span className="font-mono text-xs font-bold px-2.5 py-1 rounded-md bg-primary-50 text-primary-700 border border-primary-100">
              {project.key}
            </span>
            <Badge variant={project.status === 'active' ? 'success' : 'default'} size="sm">
              {project.status}
            </Badge>
          </div>
          <Link
            to={`/projects/${project._id}`}
            className="text-gray-400 group-hover:text-primary-600 transition-colors p-1"
          >
            <ArrowRightIcon className="w-4 h-4" />
          </Link>
        </div>

        <h3 className="mt-3 text-base font-bold text-gray-900 group-hover:text-primary-600 transition-colors">
          <Link to={`/projects/${project._id}`}>{project.name}</Link>
        </h3>

        <p className="mt-1 text-xs text-gray-500 line-clamp-2 min-h-[32px]">
          {project.description || 'No description provided.'}
        </p>
      </div>

      <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center space-x-2">
          <Avatar user={project.owner} size="sm" />
          <span>
            {project.owner
              ? `${project.owner.firstName || ''} ${project.owner.lastName || ''}`.trim()
              : 'Owner'}
          </span>
        </div>
        <span>{formatDate(project.createdAt)}</span>
      </div>
    </div>
  );
}

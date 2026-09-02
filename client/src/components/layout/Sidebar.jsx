import { NavLink, useParams, useLocation } from 'react-router';
import {
  FolderIcon,
  Squares2X2Icon,
  DocumentCheckIcon,
  CodeBracketSquareIcon,
  ClockIcon,
  Cog6ToothIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import { cn } from '../../lib/utils.js';

export default function Sidebar({ project }) {
  const { projectId } = useParams();
  const location = useLocation();

  const isProjectContext = Boolean(projectId && projectId !== 'new');

  const mainNav = [
    { name: 'Projects', href: '/projects', icon: FolderIcon },
    { name: 'Audit Logs', href: '/audit-logs', icon: ClockIcon },
  ];

  const projectNav = [
    { name: 'Dashboard', href: `/projects/${projectId}`, icon: Squares2X2Icon, end: true },
    { name: 'Issues', href: `/projects/${projectId}/issues`, icon: DocumentCheckIcon },
    {
      name: 'Repositories',
      href: `/projects/${projectId}/repositories`,
      icon: CodeBracketSquareIcon,
    },
    { name: 'Settings & Members', href: `/projects/${projectId}/settings`, icon: Cog6ToothIcon },
  ];

  return (
    <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col flex-shrink-0 min-h-screen border-r border-slate-800">
      {/* Brand header */}
      <div className="h-16 flex items-center px-6 border-b border-slate-800/80 bg-slate-950/40">
        <div className="flex items-center space-x-3">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-primary-600 to-indigo-500 flex items-center justify-center text-white font-bold text-lg shadow-md shadow-primary-500/20">
            U
          </div>
          <div>
            <span className="font-bold text-white tracking-tight text-sm">Unified DevOps</span>
            <span className="block text-[10px] text-slate-400 font-medium tracking-wider uppercase">
              Platform
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 py-5 space-y-6 overflow-y-auto">
        {/* Project Context Header if in a project */}
        {isProjectContext && project && (
          <div className="p-3 bg-slate-800/60 rounded-xl border border-slate-700/50">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Current Project
              </span>
              <span className="text-xs font-mono font-bold bg-primary-500/20 text-primary-400 px-2 py-0.5 rounded">
                {project.key}
              </span>
            </div>
            <p className="mt-1 text-sm font-semibold text-white truncate">{project.name}</p>
          </div>
        )}

        {/* Project-specific navigation */}
        {isProjectContext ? (
          <div>
            <p className="px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Project View
            </p>
            <nav className="space-y-1">
              {projectNav.map((item) => {
                const Icon = item.icon;
                const isActive = item.end
                  ? location.pathname === item.href
                  : location.pathname.startsWith(item.href);

                return (
                  <NavLink
                    key={item.name}
                    to={item.href}
                    end={item.end}
                    className={cn(
                      'flex items-center px-3 py-2.5 text-sm font-medium rounded-lg transition-colors group',
                      isActive
                        ? 'bg-primary-600 text-white shadow-sm shadow-primary-900/50'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    )}
                  >
                    <Icon className="mr-3 h-5 w-5 flex-shrink-0" />
                    {item.name}
                  </NavLink>
                );
              })}
            </nav>
          </div>
        ) : null}

        {/* Global navigation */}
        <div>
          <p className="px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Platform
          </p>
          <nav className="space-y-1">
            {mainNav.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.name}
                  to={item.href}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center px-3 py-2.5 text-sm font-medium rounded-lg transition-colors',
                      isActive && !isProjectContext
                        ? 'bg-primary-600 text-white shadow-sm shadow-primary-900/50'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    )
                  }
                >
                  <Icon className="mr-3 h-5 w-5 flex-shrink-0" />
                  {item.name}
                </NavLink>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Quick Action footer */}
      <div className="p-4 border-t border-slate-800/80 bg-slate-950/20">
        <NavLink
          to="/projects/new"
          className="w-full flex items-center justify-center px-4 py-2.5 text-sm font-medium text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 transition-colors"
        >
          <PlusIcon className="w-4 h-4 mr-2" />
          New Project
        </NavLink>
      </div>
    </aside>
  );
}

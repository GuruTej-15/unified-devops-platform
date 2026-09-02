import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate, Link } from 'react-router';
import { logoutUser } from '../../features/auth/authSlice.js';
import Avatar from '../ui/Avatar.jsx';
import Badge from '../ui/Badge.jsx';
import { ArrowRightOnRectangleIcon, UserCircleIcon } from '@heroicons/react/24/outline';

export default function TopNav({ project }) {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { user } = useSelector((state) => state.auth);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const handleLogout = async () => {
    await dispatch(logoutUser());
    navigate('/login');
  };

  return (
    <header className="h-16 bg-white border-b border-gray-200/80 px-6 flex items-center justify-between sticky top-0 z-30 shadow-2xs">
      {/* Breadcrumb area */}
      <div className="flex items-center space-x-2 text-sm text-gray-500">
        <Link to="/projects" className="hover:text-gray-900 transition-colors font-medium">
          Projects
        </Link>
        {project && (
          <>
            <span className="text-gray-300">/</span>
            <span className="font-semibold text-gray-900">{project.name}</span>
            <Badge variant="primary" size="sm" className="ml-1 font-mono">
              {project.key}
            </Badge>
          </>
        )}
      </div>

      {/* User profile dropdown */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="flex items-center space-x-3 p-1.5 rounded-lg hover:bg-gray-50 focus:outline-none transition-colors cursor-pointer"
        >
          <Avatar user={user} size="sm" />
          <div className="text-left hidden md:block">
            <p className="text-xs font-semibold text-gray-900 leading-tight">
              {user
                ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username
                : 'User'}
            </p>
            <span className="text-[11px] text-gray-500 capitalize">
              {user?.role || 'Developer'}
            </span>
          </div>
        </button>

        {dropdownOpen && (
          <div
            className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-gray-100 py-1.5 z-50 animate-in fade-in slide-in-from-top-1"
            onMouseLeave={() => setDropdownOpen(false)}
          >
            <div className="px-4 py-2 border-b border-gray-100">
              <p className="text-sm font-semibold text-gray-900">{user?.username}</p>
              <p className="text-xs text-gray-500 truncate">{user?.email}</p>
              <Badge variant="info" size="sm" className="mt-1 capitalize">
                {user?.role}
              </Badge>
            </div>

            <Link
              to="/profile"
              onClick={() => setDropdownOpen(false)}
              className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <UserCircleIcon className="w-4 h-4 mr-2.5 text-gray-400" />
              Profile Settings
            </Link>

            <button
              type="button"
              onClick={handleLogout}
              className="w-full text-left flex items-center px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
            >
              <ArrowRightOnRectangleIcon className="w-4 h-4 mr-2.5 text-red-500" />
              Sign Out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

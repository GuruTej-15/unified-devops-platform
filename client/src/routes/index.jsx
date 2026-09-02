import { Routes, Route, Navigate } from 'react-router';
import ProtectedRoute from '../components/ProtectedRoute.jsx';
import AppLayout from '../components/layout/AppLayout.jsx';

// Auth Pages
import LoginPage from '../features/auth/LoginPage.jsx';
import RegisterPage from '../features/auth/RegisterPage.jsx';
import ProfilePage from '../features/auth/ProfilePage.jsx';

// Project Pages
import ProjectListPage from '../features/projects/ProjectListPage.jsx';
import ProjectCreatePage from '../features/projects/ProjectCreatePage.jsx';
import ProjectSettingsPage from '../features/projects/ProjectSettingsPage.jsx';

// Issue Pages
import IssueListPage from '../features/issues/IssueListPage.jsx';
import IssueCreatePage from '../features/issues/IssueCreatePage.jsx';
import IssueDetailPage from '../features/issues/IssueDetailPage.jsx';

// VCS Pages
import RepositoryPage from '../features/vcs/RepositoryPage.jsx';

// Dashboard & Audit Pages
import DashboardPage from '../features/dashboard/DashboardPage.jsx';
import AuditLogPage from '../features/audit/AuditLogPage.jsx';

export default function AppRoutes() {
  return (
    <Routes>
      {/* Public Auth Routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/* Protected App Routes */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Navigate to="/projects" replace />} />

          {/* Projects */}
          <Route path="/projects" element={<ProjectListPage />} />
          <Route path="/projects/new" element={<ProjectCreatePage />} />
          <Route path="/projects/:projectId" element={<DashboardPage />} />
          <Route path="/projects/:projectId/settings" element={<ProjectSettingsPage />} />

          {/* Issues */}
          <Route path="/projects/:projectId/issues" element={<IssueListPage />} />
          <Route path="/projects/:projectId/issues/new" element={<IssueCreatePage />} />
          <Route path="/projects/:projectId/issues/:issueKey" element={<IssueDetailPage />} />

          {/* VCS / Repositories */}
          <Route path="/projects/:projectId/repositories" element={<RepositoryPage />} />

          {/* Platform Views */}
          <Route path="/audit-logs" element={<AuditLogPage />} />
          <Route path="/profile" element={<ProfilePage />} />
        </Route>
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}

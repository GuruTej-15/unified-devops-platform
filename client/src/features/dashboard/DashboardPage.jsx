import { useState, useEffect } from 'react';
import { useOutletContext, Link, useParams } from 'react-router';
import api from '../../lib/axios.js';
import StatsOverview from './components/StatsOverview.jsx';
import IssuesByStatus from './components/IssuesByStatus.jsx';
import RecentActivity from './components/RecentActivity.jsx';
import RecentCommits from './components/RecentCommits.jsx';
import PipelineSummary from './components/PipelineSummary.jsx';
import Card from '../../components/ui/Card.jsx';
import Button from '../../components/ui/Button.jsx';
import LoadingSpinner from '../../components/ui/LoadingSpinner.jsx';
import {
  PlusIcon,
  CodeBracketSquareIcon,
  DocumentCheckIcon,
  ArrowRightIcon,
} from '@heroicons/react/24/outline';
import { getSocket } from '../../lib/socket.js';

export default function DashboardPage() {
  const { projectId } = useParams();
  const { project } = useOutletContext();

  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchDashboard = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/projects/${projectId}/dashboard`);
      setDashboard(res.data);
    } catch (err) {
      console.error('Failed to load dashboard data', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetchDashboard();
    }
  }, [projectId]);

  // Real-time socket event updates
  useEffect(() => {
    const socket = getSocket();
    const handleUpdate = () => {
      fetchDashboard();
    };

    socket.on('issue.created', handleUpdate);
    socket.on('issue.updated', handleUpdate);
    socket.on('issue.status.changed', handleUpdate);
    socket.on('repository.synced', handleUpdate);
    socket.on('project.member.added', handleUpdate);
    socket.on('pipeline.run.received', handleUpdate);
    socket.on('pipeline.run.completed', handleUpdate);
    socket.on('pipeline.updated', handleUpdate);

    return () => {
      socket.off('issue.created', handleUpdate);
      socket.off('issue.updated', handleUpdate);
      socket.off('issue.status.changed', handleUpdate);
      socket.off('repository.synced', handleUpdate);
      socket.off('project.member.added', handleUpdate);
      socket.off('pipeline.run.received', handleUpdate);
      socket.off('pipeline.run.completed', handleUpdate);
      socket.off('pipeline.updated', handleUpdate);
    };
  }, [projectId]);

  if (loading) {
    return <LoadingSpinner size="lg" label="Loading dashboard..." />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
            {project?.name || 'Project'} Dashboard
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Real-time delivery progress, source control activity, and work state
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <Link to={`/projects/${projectId}/repositories`}>
            <Button size="sm" variant="secondary">
              <CodeBracketSquareIcon className="w-4 h-4 mr-1.5" />
              Repositories
            </Button>
          </Link>
          <Link to={`/projects/${projectId}/issues/new`}>
            <Button size="sm">
              <PlusIcon className="w-4 h-4 mr-1.5" />
              New Issue
            </Button>
          </Link>
        </div>
      </div>

      {/* Top Metrics Cards */}
      <StatsOverview dashboard={dashboard} />

      {/* Main Grid: Charts & Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Issues by Status Chart */}
        <div className="lg:col-span-2">
          <Card
            title="Work Breakdown & Issue Status"
            subtitle="Current delivery queue by lifecycle status"
            action={
              <Link
                to={`/projects/${projectId}/issues`}
                className="text-xs font-semibold text-primary-600 hover:underline flex items-center"
              >
                View all issues <ArrowRightIcon className="w-3 h-3 ml-1" />
              </Link>
            }
          >
            <IssuesByStatus issueStats={dashboard?.issueStats} />
          </Card>
        </div>

        {/* Live Project Activity Feed */}
        <div className="lg:col-span-1">
          <Card
            title="Recent Activity"
            subtitle="Latest project audit trail"
            action={
              <Link
                to="/audit-logs"
                className="text-xs font-semibold text-primary-600 hover:underline"
              >
                Audit Log
              </Link>
            }
          >
            <RecentActivity activities={dashboard?.recentActivity} />
          </Card>
        </div>
      </div>

      {/* CI Pipeline Health */}
      <Card
        title="CI Pipeline Health"
        subtitle="GitHub Actions workflow run status and recent executions"
        action={
          <Link
            to={`/projects/${projectId}/repositories`}
            className="text-xs font-semibold text-primary-600 hover:underline flex items-center"
          >
            Manage Repositories <ArrowRightIcon className="w-3 h-3 ml-1" />
          </Link>
        }
      >
        <PipelineSummary
          pipelineStats={dashboard?.pipelineStats}
          recentPipelineRuns={dashboard?.recentPipelineRuns}
        />
      </Card>

      {/* Recent VCS Commits */}
      <Card
        title="Recent VCS Commits"
        subtitle="Latest code changes synchronized from connected repositories"
        action={
          <Link
            to={`/projects/${projectId}/repositories`}
            className="text-xs font-semibold text-primary-600 hover:underline flex items-center"
          >
            Manage Repositories <ArrowRightIcon className="w-3 h-3 ml-1" />
          </Link>
        }
      >
        <RecentCommits commits={dashboard?.recentCommits} />
      </Card>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { useParams } from 'react-router';
import api from '../../lib/axios.js';
import ConnectionStatus from './components/ConnectionStatus.jsx';
import CommitList from './components/CommitList.jsx';
import PullRequestList from './components/PullRequestList.jsx';
import BranchList from './components/BranchList.jsx';
import Button from '../../components/ui/Button.jsx';
import Input from '../../components/ui/Input.jsx';
import Card from '../../components/ui/Card.jsx';
import Modal from '../../components/ui/Modal.jsx';
import LoadingSpinner from '../../components/ui/LoadingSpinner.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import {
  CodeBracketSquareIcon,
  PlusIcon,
  ArrowPathIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { getSocket } from '../../lib/socket.js';

export default function RepositoryPage() {
  const { projectId } = useParams();

  const [repositories, setRepositories] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [activeTab, setActiveTab] = useState('commits'); // 'commits' | 'prs' | 'branches'
  const [commits, setCommits] = useState([]);
  const [pullRequests, setPullRequests] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingTabData, setLoadingTabData] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Connect Repo Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [connectData, setConnectData] = useState({
    owner: '',
    name: '',
    token: '',
  });
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);

  const fetchRepositories = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/projects/${projectId}/repositories`);
      const repos = res.data || [];
      setRepositories(repos);
      if (repos.length > 0 && !selectedRepo) {
        setSelectedRepo(repos[0]);
      }
    } catch (err) {
      console.error('Failed to load repositories', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchTabData = async (repoId) => {
    if (!repoId) return;
    setLoadingTabData(true);
    try {
      if (activeTab === 'commits') {
        const res = await api.get(`/projects/${projectId}/repositories/${repoId}/commits`);
        setCommits(res.data || []);
      } else if (activeTab === 'prs') {
        const res = await api.get(`/projects/${projectId}/repositories/${repoId}/pull-requests`);
        setPullRequests(res.data || []);
      } else if (activeTab === 'branches') {
        const res = await api.get(`/projects/${projectId}/repositories/${repoId}/branches`);
        setBranches(res.data || []);
      }
    } catch (err) {
      console.error('Failed to load tab data', err);
    } finally {
      setLoadingTabData(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetchRepositories();
    }
  }, [projectId]);

  useEffect(() => {
    if (selectedRepo) {
      fetchTabData(selectedRepo._id);
    }
  }, [selectedRepo, activeTab]);

  // Real-time socket events for repository sync
  useEffect(() => {
    const socket = getSocket();
    const handleRepoSynced = () => {
      fetchRepositories();
      if (selectedRepo) fetchTabData(selectedRepo._id);
    };

    socket.on('repository.synced', handleRepoSynced);
    socket.on('repository.sync.failed', handleRepoSynced);

    return () => {
      socket.off('repository.synced', handleRepoSynced);
      socket.off('repository.sync.failed', handleRepoSynced);
    };
  }, [projectId, selectedRepo]);

  const handleConnectSubmit = async (e) => {
    e.preventDefault();
    setConnecting(true);
    setConnectError(null);

    try {
      const res = await api.post(`/projects/${projectId}/repositories`, {
        owner: connectData.owner.trim(),
        name: connectData.name.trim(),
        token: connectData.token.trim(),
      });
      setModalOpen(false);
      setConnectData({ owner: '', name: '', token: '' });
      await fetchRepositories();
      setSelectedRepo(res.data);
    } catch (err) {
      setConnectError(err.message);
    } finally {
      setConnecting(false);
    }
  };

  const handleSync = async () => {
    if (!selectedRepo) return;
    setSyncing(true);
    try {
      await api.post(`/projects/${projectId}/repositories/${selectedRepo._id}/sync`);
      await fetchRepositories();
      fetchTabData(selectedRepo._id);
    } catch (err) {
      alert(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    if (!selectedRepo) return;
    if (!window.confirm(`Are you sure you want to disconnect ${selectedRepo.fullName}?`)) return;

    try {
      await api.delete(`/projects/${projectId}/repositories/${selectedRepo._id}`);
      setSelectedRepo(null);
      fetchRepositories();
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
            Source Control & Repositories
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Connect and synchronize GitHub repositories for unified delivery traceability
          </p>
        </div>
        <Button size="md" onClick={() => setModalOpen(true)}>
          <PlusIcon className="w-4 h-4 mr-2" />
          Connect Repository
        </Button>
      </div>

      {loading ? (
        <LoadingSpinner size="lg" label="Loading repositories..." />
      ) : repositories.length > 0 ? (
        <div className="space-y-6">
          {/* Repository Selector if multiple */}
          {repositories.length > 1 && (
            <div className="flex items-center space-x-2 overflow-x-auto pb-2">
              {repositories.map((repo) => (
                <button
                  key={repo._id}
                  onClick={() => setSelectedRepo(repo)}
                  className={`px-4 py-2 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
                    selectedRepo?._id === repo._id
                      ? 'bg-primary-600 text-white border-primary-600 shadow-sm'
                      : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {repo.fullName}
                </button>
              ))}
            </div>
          )}

          {selectedRepo && (
            <>
              {/* Connection Status & Health Card */}
              <ConnectionStatus repository={selectedRepo} />

              {/* Action Toolbar */}
              <div className="flex items-center justify-between">
                {/* Tabs */}
                <div className="flex space-x-1 bg-gray-100 p-1 rounded-xl">
                  <button
                    onClick={() => setActiveTab('commits')}
                    className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                      activeTab === 'commits'
                        ? 'bg-white text-gray-900 shadow-xs'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    Commits ({commits.length})
                  </button>
                  <button
                    onClick={() => setActiveTab('prs')}
                    className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                      activeTab === 'prs'
                        ? 'bg-white text-gray-900 shadow-xs'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    Pull Requests ({pullRequests.length})
                  </button>
                  <button
                    onClick={() => setActiveTab('branches')}
                    className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                      activeTab === 'branches'
                        ? 'bg-white text-gray-900 shadow-xs'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    Live Branches
                  </button>
                </div>

                <div className="flex items-center space-x-2">
                  <Button size="sm" variant="secondary" onClick={handleSync} loading={syncing}>
                    <ArrowPathIcon className={`w-4 h-4 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
                    Sync Now
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={handleDisconnect}
                    title="Disconnect repository"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Tab Content */}
              {loadingTabData ? (
                <LoadingSpinner size="md" label={`Fetching ${activeTab}...`} />
              ) : activeTab === 'commits' ? (
                <CommitList commits={commits} />
              ) : activeTab === 'prs' ? (
                <PullRequestList pullRequests={pullRequests} />
              ) : (
                <BranchList branches={branches} />
              )}
            </>
          )}
        </div>
      ) : (
        <EmptyState
          icon={CodeBracketSquareIcon}
          title="No repositories connected"
          description="Connect a GitHub repository to automatically link commits, branches, and PRs to your project issues."
          actionLabel="Connect GitHub Repository"
          onAction={() => setModalOpen(true)}
        />
      )}

      {/* Connect Repository Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Connect GitHub Repository"
      >
        {connectError && (
          <div className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
            {connectError}
          </div>
        )}

        <form onSubmit={handleConnectSubmit} className="space-y-4">
          <div className="p-3 bg-blue-50 text-blue-800 text-xs rounded-lg border border-blue-200">
            <p className="font-semibold">Security Note:</p>
            <p className="mt-0.5">
              Your Personal Access Token (PAT) is validated server-side, encrypted with AES-256-GCM,
              and never stored in plaintext or exposed to the client.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Repository Owner / Org"
              required
              placeholder="e.g. octocat or my-org"
              value={connectData.owner}
              onChange={(e) => setConnectData({ ...connectData, owner: e.target.value })}
            />
            <Input
              label="Repository Name"
              required
              placeholder="e.g. payment-service"
              value={connectData.name}
              onChange={(e) => setConnectData({ ...connectData, name: e.target.value })}
            />
          </div>

          <Input
            label="GitHub Personal Access Token (PAT)"
            type="password"
            required
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            value={connectData.token}
            onChange={(e) => setConnectData({ ...connectData, token: e.target.value })}
            helperText="Requires 'repo' scope for private repos or public access for public repos."
          />

          <div className="flex justify-end space-x-3 pt-4 border-t border-gray-100">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={connecting}>
              Connect & Validate
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

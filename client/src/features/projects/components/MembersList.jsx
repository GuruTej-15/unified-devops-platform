import { useState, useEffect } from 'react';
import api from '../../../lib/axios.js';
import Avatar from '../../../components/ui/Avatar.jsx';
import Badge from '../../../components/ui/Badge.jsx';
import Button from '../../../components/ui/Button.jsx';
import Select from '../../../components/ui/Select.jsx';
import Modal from '../../../components/ui/Modal.jsx';
import LoadingSpinner from '../../../components/ui/LoadingSpinner.jsx';
import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline';

export default function MembersList({ projectId, isOwnerOrAdmin = true }) {
  const [members, setMembers] = useState([]);
  const [availableUsers, setAvailableUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRole, setSelectedRole] = useState('developer');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const fetchMembers = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/projects/${projectId}/members`);
      setMembers(res.data || []);
    } catch (err) {
      console.error('Failed to load members', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await api.get('/users');
      setAvailableUsers(res.data || []);
    } catch (err) {
      console.error('Failed to load users', err);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetchMembers();
    }
  }, [projectId]);

  const handleOpenAddModal = () => {
    fetchUsers();
    setError(null);
    setSelectedUserId('');
    setSelectedRole('developer');
    setModalOpen(true);
  };

  const handleAddMember = async (e) => {
    e.preventDefault();
    if (!selectedUserId) {
      setError('Please select a user to add');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await api.post(`/projects/${projectId}/members`, {
        userId: selectedUserId,
        role: selectedRole,
      });
      setModalOpen(false);
      fetchMembers();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemoveMember = async (userId) => {
    if (!window.confirm('Are you sure you want to remove this member?')) return;
    try {
      await api.delete(`/projects/${projectId}/members/${userId}`);
      fetchMembers();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    try {
      await api.put(`/projects/${projectId}/members/${userId}`, { role: newRole });
      fetchMembers();
    } catch (err) {
      alert(err.message);
    }
  };

  const roleOptions = [
    { value: 'owner', label: 'Owner' },
    { value: 'admin', label: 'Admin' },
    { value: 'developer', label: 'Developer' },
    { value: 'viewer', label: 'Viewer' },
  ];

  // Exclude users already members
  const memberUserIds = new Set(members.map((m) => m.user?._id));
  const userSelectOptions = [
    { value: '', label: 'Select a user...' },
    ...availableUsers
      .filter((u) => !memberUserIds.has(u._id))
      .map((u) => ({
        value: u._id,
        label: `${u.firstName || ''} ${u.lastName || ''} (@${u.username}) - ${u.email}`,
      })),
  ];

  if (loading) {
    return <LoadingSpinner size="md" label="Loading members..." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Project Members</h3>
          <p className="text-xs text-gray-500">
            Control access and assign team roles for this delivery context
          </p>
        </div>
        {isOwnerOrAdmin && (
          <Button size="sm" onClick={handleOpenAddModal}>
            <PlusIcon className="w-4 h-4 mr-1.5" />
            Add Member
          </Button>
        )}
      </div>

      <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white overflow-hidden">
        {members.map((member) => (
          <div
            key={member._id}
            className="p-4 flex items-center justify-between hover:bg-gray-50/50 transition-colors"
          >
            <div className="flex items-center space-x-3">
              <Avatar user={member.user} size="md" />
              <div>
                <p className="text-sm font-semibold text-gray-900">
                  {member.user
                    ? `${member.user.firstName || ''} ${member.user.lastName || ''}`.trim()
                    : 'Unknown User'}
                </p>
                <p className="text-xs text-gray-500">
                  @{member.user?.username} • {member.user?.email}
                </p>
              </div>
            </div>

            <div className="flex items-center space-x-3">
              {isOwnerOrAdmin && member.role !== 'owner' ? (
                <select
                  value={member.role}
                  onChange={(e) => handleRoleChange(member.user._id, e.target.value)}
                  className="text-xs font-medium border border-gray-300 rounded-md px-2.5 py-1 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
                >
                  {roleOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Badge
                  variant={member.role === 'owner' ? 'primary' : 'default'}
                  size="md"
                  className="capitalize font-medium"
                >
                  {member.role}
                </Badge>
              )}

              {isOwnerOrAdmin && member.role !== 'owner' && (
                <button
                  type="button"
                  onClick={() => handleRemoveMember(member.user._id)}
                  className="text-gray-400 hover:text-red-600 transition-colors p-1"
                  title="Remove Member"
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Add Member Modal */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Add Team Member">
        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
            {error}
          </div>
        )}
        <form onSubmit={handleAddMember} className="space-y-4">
          <Select
            label="User"
            required
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            options={userSelectOptions}
          />

          <Select
            label="Project Role"
            required
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
            options={roleOptions.filter((r) => r.value !== 'owner')}
          />

          <div className="flex justify-end space-x-3 pt-4 border-t border-gray-100">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Add to Project
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

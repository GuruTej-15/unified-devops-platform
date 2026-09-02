import Badge from '../../../components/ui/Badge.jsx';
import { formatDate } from '../../../lib/utils.js';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';

export default function ConnectionStatus({ repository }) {
  const {
    connectionStatus,
    lastSyncedAt,
    lastSuccessfulSyncAt,
    lastSyncStatus,
    lastSyncError,
    tokenHint,
  } = repository;

  const statusConfig = {
    connected: {
      badgeVariant: 'success',
      icon: CheckCircleIcon,
      label: 'Connected & Healthy',
      textColor: 'text-emerald-700',
    },
    syncing: {
      badgeVariant: 'primary',
      icon: ArrowPathIcon,
      label: 'Syncing...',
      textColor: 'text-primary-700',
    },
    failed: {
      badgeVariant: 'danger',
      icon: ExclamationTriangleIcon,
      label: 'Synchronization Failed',
      textColor: 'text-red-700',
    },
    disconnected: {
      badgeVariant: 'default',
      icon: XCircleIcon,
      label: 'Disconnected',
      textColor: 'text-gray-500',
    },
  };

  const current = statusConfig[connectionStatus] || statusConfig.connected;
  const Icon = current.icon;

  return (
    <div className="bg-white rounded-xl border border-gray-200/80 p-5 shadow-xs">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded-lg bg-gray-50 border border-gray-100">
            <Icon
              className={`w-5 h-5 ${current.textColor} ${connectionStatus === 'syncing' ? 'animate-spin' : ''}`}
            />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h4 className="text-sm font-bold text-gray-900">{repository.fullName}</h4>
              <Badge variant={current.badgeVariant} size="sm">
                {current.label}
              </Badge>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              Provider: <span className="font-semibold capitalize">{repository.provider}</span> •
              Token: <span className="font-mono">{tokenHint || '••••••••'}</span>
            </p>
          </div>
        </div>

        <div className="text-left sm:text-right text-xs text-gray-500">
          {connectionStatus === 'failed' ? (
            <>
              <p className="text-red-600 font-semibold">
                Sync failed at {lastSyncedAt ? formatDate(lastSyncedAt) : 'N/A'}
              </p>
              {lastSuccessfulSyncAt && (
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Last successful sync:{' '}
                  <span className="font-medium text-gray-700">
                    {formatDate(lastSuccessfulSyncAt)}
                  </span>
                </p>
              )}
            </>
          ) : (
            <p>
              Last Synced:{' '}
              <span className="font-medium text-gray-800">
                {lastSyncedAt ? formatDate(lastSyncedAt) : 'Never'}
              </span>
            </p>
          )}
          <p className="text-[11px] text-gray-400 mt-0.5">
            Default Branch:{' '}
            <span className="font-mono font-semibold text-gray-600">
              {repository.defaultBranch}
            </span>
          </p>
        </div>
      </div>

      {lastSyncError && (
        <div className="mt-3 p-3 bg-red-50 text-red-700 text-xs rounded-lg border border-red-200 flex items-start space-x-2">
          <ExclamationTriangleIcon className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Reason: </span>
            {lastSyncError}
          </div>
        </div>
      )}
    </div>
  );
}

import BaseOrchestrationProvider from './baseOrchestrationProvider.js';
import {
  ORCHESTRATION_PROVIDER,
  ORCHESTRATION_SYNC_STATUS,
  ORCHESTRATION_HEALTH_STATUS,
} from '../../../shared/constants.js';
import { validateServerUrl } from '../../../shared/urlValidator.js';
import { BadRequestError } from '../../../shared/errors.js';

/**
 * Normalizes Argo CD sync status string to platform standard.
 *
 * @param {string} status
 * @returns {string}
 */
export function normalizeArgoSyncStatus(status) {
  if (!status || typeof status !== 'string') return ORCHESTRATION_SYNC_STATUS.UNKNOWN;
  const s = status.toLowerCase().replace(/[^a-z]/g, '');
  if (s === 'synced') return ORCHESTRATION_SYNC_STATUS.SYNCED;
  if (s === 'outofsync') return ORCHESTRATION_SYNC_STATUS.OUT_OF_SYNC;
  return ORCHESTRATION_SYNC_STATUS.UNKNOWN;
}

/**
 * Normalizes Argo CD health status string to platform standard.
 *
 * @param {string} status
 * @returns {string}
 */
export function normalizeArgoHealthStatus(status) {
  if (!status || typeof status !== 'string') return ORCHESTRATION_HEALTH_STATUS.UNKNOWN;
  const s = status.toLowerCase().trim();
  switch (s) {
    case 'healthy':
      return ORCHESTRATION_HEALTH_STATUS.HEALTHY;
    case 'progressing':
      return ORCHESTRATION_HEALTH_STATUS.PROGRESSING;
    case 'degraded':
      return ORCHESTRATION_HEALTH_STATUS.DEGRADED;
    case 'suspended':
      return ORCHESTRATION_HEALTH_STATUS.SUSPENDED;
    case 'missing':
      return ORCHESTRATION_HEALTH_STATUS.MISSING;
    default:
      return ORCHESTRATION_HEALTH_STATUS.UNKNOWN;
  }
}

/**
 * Sanitizes error messages to ensure credentials never leak into logs or errors.
 *
 * @param {string} message
 * @param {string} [token]
 * @returns {string}
 */
function sanitizeErrorMessage(message, token) {
  if (!message) return 'Argo CD request failed';
  let safe = String(message);
  if (token && typeof token === 'string' && token.length > 0) {
    safe = safe.split(token).join('[REDACTED]');
  }
  return safe;
}

/**
 * Concrete Argo CD Orchestration Provider adapter.
 * Handles read-only observation via Argo CD REST API and payload normalization.
 */
export default class ArgoCDProvider extends BaseOrchestrationProvider {
  /**
   * Return provider identifier.
   * @returns {string}
   */
  getProviderName() {
    return ORCHESTRATION_PROVIDER.ARGOCD;
  }

  /**
   * Test connectivity and authentication against an Argo CD server.
   *
   * @param {object} params
   * @param {string} params.serverUrl
   * @param {string} params.token
   * @param {string} [params.applicationName]
   * @param {number} [params.timeoutMs=5000]
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async testConnection({ serverUrl, token, applicationName, timeoutMs = 5000 } = {}) {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new BadRequestError('Authentication token is required to test Argo CD connection');
    }

    const cleanToken = token.trim();
    const normalizedServerUrl = validateServerUrl(serverUrl);

    const testPath = applicationName
      ? `/api/v1/applications/${encodeURIComponent(applicationName.trim())}`
      : '/api/v1/applications?fields=items.metadata.name';

    const targetUrl = `${normalizedServerUrl}${testPath}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          message: 'Argo CD authentication failed: Invalid credentials or token expired',
        };
      }

      if (response.status === 404) {
        return {
          success: false,
          message: applicationName
            ? `Argo CD application '${applicationName}' not found`
            : 'Argo CD endpoint not found',
        };
      }

      if (!response.ok) {
        return {
          success: false,
          message: `Argo CD responded with HTTP status ${response.status}`,
        };
      }

      return {
        success: true,
        message: 'Argo CD connection successful',
      };
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return {
          success: false,
          message: 'Argo CD connection timed out',
        };
      }
      return {
        success: false,
        message: sanitizeErrorMessage(err.message, cleanToken),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fetch application workload status from Argo CD REST API.
   * Primary endpoint: GET /api/v1/applications/{applicationName}
   *
   * @param {object} params
   * @param {string} params.serverUrl - Target Argo CD server URL (validated against SSRF)
   * @param {string} params.token - Raw decrypted token (never persisted or leaked)
   * @param {string} params.applicationName - Name of the application to observe
   * @param {number} [params.timeoutMs=5000] - Request timeout in milliseconds
   * @returns {Promise<object>} Normalized workload status
   */
  async fetchWorkloadStatus({ serverUrl, token, applicationName, timeoutMs = 5000 } = {}) {
    if (!applicationName || typeof applicationName !== 'string' || !applicationName.trim()) {
      throw new BadRequestError('Application name is required to fetch Argo CD status');
    }
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new BadRequestError('Authentication token is required to fetch Argo CD status');
    }

    const cleanToken = token.trim();
    const cleanAppName = applicationName.trim();
    const normalizedServerUrl = validateServerUrl(serverUrl);
    const targetUrl = `${normalizedServerUrl}/api/v1/applications/${encodeURIComponent(cleanAppName)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorDetail = `HTTP ${response.status}`;
        try {
          const errBody = await response.json();
          if (errBody && errBody.message) {
            errorDetail = errBody.message;
          }
        } catch {
          // Non-JSON error body fallback
        }
        const safeDetail = sanitizeErrorMessage(errorDetail, cleanToken);
        throw new Error(`Argo CD API returned ${response.status}: ${safeDetail}`);
      }

      const rawApp = await response.json();
      return this.normalizeWorkloadStatus(rawApp, { applicationName: cleanAppName });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new Error('Argo CD API request timed out');
      }
      const safeMessage = sanitizeErrorMessage(err.message, cleanToken);
      throw new Error(`Argo CD API request failed: ${safeMessage}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Normalizes raw Argo CD application data into standard platform schema.
   * Tolerant of missing optional fields, unwraps notifications or direct application objects.
   *
   * @param {object} rawWorkload
   * @param {object} [context]
   * @returns {object}
   */
  normalizeWorkloadStatus(rawWorkload, context = {}) {
    if (!rawWorkload || typeof rawWorkload !== 'object') {
      return {
        applicationName: context.applicationName || '',
        namespace: '',
        syncStatus: ORCHESTRATION_SYNC_STATUS.UNKNOWN,
        healthStatus: ORCHESTRATION_HEALTH_STATUS.UNKNOWN,
        revision: null,
        operationPhase: null,
        healthMessage: null,
        operationMessage: null,
        resources: [],
        outOfSyncResources: [],
        hasDrift: false,
      };
    }

    const app = rawWorkload.app || rawWorkload.application || rawWorkload;

    // 1. Application Name & Namespace
    const applicationName =
      app.metadata?.name || app.applicationName || app.name || context.applicationName || '';
    const namespace =
      app.metadata?.namespace || app.spec?.destination?.namespace || app.namespace || '';

    // 2. Sync Status & Target Revision
    const rawSyncStatus = app.status?.sync?.status || app.syncStatus || null;
    const syncStatus = normalizeArgoSyncStatus(rawSyncStatus);

    const revision =
      app.status?.sync?.revision ||
      app.status?.operationState?.syncResult?.revision ||
      app.revision ||
      null;

    // 3. Health Status & Health Message
    const rawHealthStatus = app.status?.health?.status || app.healthStatus || null;
    const healthStatus = normalizeArgoHealthStatus(rawHealthStatus);
    const healthMessage = app.status?.health?.message || null;

    // 4. Operation Phase & Message
    const rawOpPhase = app.status?.operationState?.phase || app.operationPhase || null;
    const operationPhase = rawOpPhase ? String(rawOpPhase).toLowerCase() : null;
    const operationMessage = app.status?.operationState?.message || null;

    // 5. Managed Resources & Drift Detection
    const rawResources = Array.isArray(app.status?.resources) ? app.status.resources : [];
    const resources = rawResources.map((r) => {
      const resourceSync = normalizeArgoSyncStatus(r.status);
      const resourceHealth = normalizeArgoHealthStatus(r.health?.status);
      return {
        group: r.group || '',
        version: r.version || '',
        kind: r.kind || '',
        namespace: r.namespace || '',
        name: r.name || '',
        status: resourceSync,
        healthStatus: resourceHealth,
        message: r.health?.message || '',
      };
    });

    const outOfSyncResources = resources.filter(
      (r) => r.status !== ORCHESTRATION_SYNC_STATUS.SYNCED
    );

    const hasDrift =
      syncStatus === ORCHESTRATION_SYNC_STATUS.OUT_OF_SYNC || outOfSyncResources.length > 0;

    return {
      applicationName,
      namespace,
      syncStatus,
      healthStatus,
      revision,
      operationPhase,
      healthMessage,
      operationMessage,
      resources,
      outOfSyncResources,
      hasDrift,
    };
  }

  /**
   * Detect drift from normalized or raw workload representation.
   *
   * @param {object} workload
   * @returns {{ hasDrift: boolean, outOfSyncResources: Array<object> }}
   */
  detectDrift(workload) {
    if (!workload) {
      return { hasDrift: false, outOfSyncResources: [] };
    }

    if (Array.isArray(workload.outOfSyncResources) && typeof workload.hasDrift === 'boolean') {
      return {
        hasDrift: workload.hasDrift,
        outOfSyncResources: workload.outOfSyncResources,
      };
    }

    const normalized = this.normalizeWorkloadStatus(workload);
    return {
      hasDrift: normalized.hasDrift,
      outOfSyncResources: normalized.outOfSyncResources,
    };
  }
}

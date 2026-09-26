import https from 'node:https';
import BaseOrchestrationProvider from './baseOrchestrationProvider.js';
import { ORCHESTRATION_PROVIDER } from '../../../shared/constants.js';
import { validateServerUrl } from '../../../shared/urlValidator.js';
import { BadRequestError } from '../../../shared/errors.js';

/**
 * Sanitizes error messages to prevent token and CA credential leakage.
 *
 * @param {string} message
 * @param {string} [token]
 * @returns {string}
 */
export function sanitizeKubernetesErrorMessage(message, token) {
  if (!message) return 'Kubernetes request failed';
  let safe = String(message);
  if (token && typeof token === 'string' && token.length > 0) {
    safe = safe.split(token).join('[REDACTED]');
  }
  return safe;
}

/**
 * Interpret health of a Kubernetes Deployment.
 *
 * @param {object} raw
 * @param {number} desired
 * @param {number} ready
 * @param {number} available
 * @param {number} updated
 * @returns {{ status: 'healthy' | 'progressing' | 'degraded' | 'unknown', message: string }}
 */
export function interpretDeploymentHealth(raw, desired, ready, available, updated) {
  const status = raw?.status;
  if (!status || typeof status !== 'object') {
    return { status: 'unknown', message: 'Status information unavailable' };
  }

  const conditions = Array.isArray(status.conditions) ? status.conditions : [];

  // Check for degraded conditions first
  const progressingCond = conditions.find((c) => c.type === 'Progressing');
  if (
    progressingCond?.status === 'False' &&
    progressingCond.reason === 'ProgressDeadlineExceeded'
  ) {
    return {
      status: 'degraded',
      message: progressingCond.message || 'Deployment progress deadline exceeded',
    };
  }

  const replicaFailureCond = conditions.find((c) => c.type === 'ReplicaFailure');
  if (replicaFailureCond?.status === 'True') {
    return {
      status: 'degraded',
      message: replicaFailureCond.message || 'Deployment replica creation failed',
    };
  }

  // Generation check
  const generation =
    raw.metadata?.generation !== undefined ? Number(raw.metadata.generation) : null;
  const observedGeneration =
    status.observedGeneration !== undefined ? Number(status.observedGeneration) : null;
  if (generation !== null && observedGeneration !== null && observedGeneration < generation) {
    return {
      status: 'progressing',
      message: `Rollout in progress: waiting for generation ${generation} (observed: ${observedGeneration})`,
    };
  }

  // Replica checks
  if (desired === 0) {
    if (available === 0 && ready === 0) {
      return { status: 'healthy', message: 'Deployment scaled to 0 replicas' };
    }
    return { status: 'progressing', message: 'Deployment scaling down to 0 replicas' };
  }

  if (available >= desired && updated >= desired) {
    return { status: 'healthy', message: `All ${desired} replicas are ready and available` };
  }

  if (available < desired || updated < desired) {
    return {
      status: 'progressing',
      message: `Rollout in progress: ${available}/${desired} replicas available, ${updated}/${desired} updated`,
    };
  }

  return { status: 'unknown', message: 'Deployment state could not be determined' };
}

/**
 * Interpret health of a Kubernetes StatefulSet.
 *
 * @param {object} raw
 * @param {number} desired
 * @param {number} ready
 * @param {number} updated
 * @returns {{ status: 'healthy' | 'progressing' | 'degraded' | 'unknown', message: string }}
 */
export function interpretStatefulSetHealth(raw, desired, ready, updated) {
  const status = raw?.status;
  if (!status || typeof status !== 'object') {
    return { status: 'unknown', message: 'Status information unavailable' };
  }

  const generation =
    raw.metadata?.generation !== undefined ? Number(raw.metadata.generation) : null;
  const observedGeneration =
    status.observedGeneration !== undefined ? Number(status.observedGeneration) : null;
  if (generation !== null && observedGeneration !== null && observedGeneration < generation) {
    return {
      status: 'progressing',
      message: `StatefulSet rollout in progress: waiting for generation ${generation}`,
    };
  }

  if (desired === 0) {
    if (ready === 0) {
      return { status: 'healthy', message: 'StatefulSet scaled to 0 replicas' };
    }
    return { status: 'progressing', message: 'StatefulSet scaling down to 0 replicas' };
  }

  const currentRevision = status.currentRevision;
  const updateRevision = status.updateRevision;
  const hasRevisionMismatch =
    currentRevision && updateRevision && currentRevision !== updateRevision;

  if (ready >= desired && !hasRevisionMismatch && updated >= desired) {
    return { status: 'healthy', message: `All ${desired} replicas are ready and updated` };
  }

  if (ready < desired || hasRevisionMismatch || updated < desired) {
    return {
      status: 'progressing',
      message: `StatefulSet converging: ${ready}/${desired} ready, ${updated}/${desired} updated`,
    };
  }

  return { status: 'unknown', message: 'StatefulSet state could not be determined' };
}

/**
 * Interpret health of a Kubernetes DaemonSet.
 *
 * @param {object} raw
 * @param {number} desired
 * @param {number} ready
 * @param {number} unavailable
 * @returns {{ status: 'healthy' | 'progressing' | 'degraded' | 'unknown', message: string }}
 */
export function interpretDaemonSetHealth(raw, desired, ready, unavailable) {
  const status = raw?.status;
  if (!status || typeof status !== 'object') {
    return { status: 'unknown', message: 'Status information unavailable' };
  }

  if (unavailable > 0) {
    return {
      status: 'degraded',
      message: `${unavailable} daemon pod(s) unavailable on scheduled nodes`,
    };
  }

  if (desired === 0) {
    return { status: 'healthy', message: 'No nodes currently scheduled for DaemonSet' };
  }

  if (ready >= desired) {
    return { status: 'healthy', message: `All ${desired} daemon pods are ready` };
  }

  if (ready < desired) {
    return {
      status: 'progressing',
      message: `DaemonSet converging: ${ready}/${desired} pods ready`,
    };
  }

  return { status: 'unknown', message: 'DaemonSet state could not be determined' };
}

/**
 * Interpret health of a Kubernetes Pod.
 *
 * @param {object} raw
 * @returns {{ status: 'healthy' | 'progressing' | 'degraded' | 'unknown', message: string }}
 */
export function interpretPodHealth(raw) {
  const status = raw?.status;
  if (!status || typeof status !== 'object') {
    return { status: 'unknown', message: 'Status information unavailable' };
  }

  const phase = status.phase || 'Unknown';
  const containerStatuses = Array.isArray(status.containerStatuses) ? status.containerStatuses : [];

  // Check container waiting or terminated failures
  for (const cs of containerStatuses) {
    if (cs.state?.waiting) {
      const reason = cs.state.waiting.reason || '';
      if (
        [
          'CrashLoopBackOff',
          'ImagePullBackOff',
          'ErrImagePull',
          'CreateContainerConfigError',
        ].includes(reason)
      ) {
        return {
          status: 'degraded',
          message: `Container '${cs.name}' in error state: ${reason}`,
        };
      }
    }
    if (cs.state?.terminated && cs.state.terminated.exitCode !== 0) {
      return {
        status: 'degraded',
        message: `Container '${cs.name}' terminated with exit code ${cs.state.terminated.exitCode}`,
      };
    }
  }

  if (phase === 'Failed') {
    return { status: 'degraded', message: status.message || 'Pod failed' };
  }

  if (phase === 'Pending') {
    return { status: 'progressing', message: 'Pod is pending' };
  }

  if (phase === 'Succeeded') {
    return { status: 'healthy', message: 'Pod completed successfully' };
  }

  if (phase === 'Running') {
    const allReady =
      containerStatuses.length > 0 && containerStatuses.every((c) => c.ready === true);
    if (allReady) {
      return { status: 'healthy', message: 'Pod is running and all containers are ready' };
    }
    return { status: 'progressing', message: 'Pod is running but containers are not ready' };
  }

  return { status: 'unknown', message: `Pod phase is ${phase}` };
}

/**
 * Read-only Kubernetes Orchestration Provider.
 * Communicates directly with Kubernetes HTTPS API using bearer-token authentication.
 * Never executes mutations (POST/PUT/PATCH/DELETE) and never runs external binaries.
 */
export default class KubernetesProvider extends BaseOrchestrationProvider {
  /**
   * Return provider identifier.
   * @returns {string}
   */
  getProviderName() {
    return ORCHESTRATION_PROVIDER.KUBERNETES;
  }

  /**
   * Helper to build an HTTPS agent with a custom CA certificate without disabling TLS validation.
   *
   * @param {string} [caCertificate]
   * @returns {https.Agent|undefined}
   */
  _buildHttpsAgent(caCertificate) {
    if (caCertificate && typeof caCertificate === 'string' && caCertificate.trim()) {
      return new https.Agent({
        ca: caCertificate.trim(),
        rejectUnauthorized: true, // Strict TLS verification enforced
      });
    }
    return undefined;
  }

  /**
   * Test connectivity and authentication to the Kubernetes API server.
   * Performs a harmless read-only GET request to /version or /api/v1/namespaces/{namespace}.
   *
   * @param {object} params
   * @param {string} params.serverUrl
   * @param {string} params.token
   * @param {string} [params.caCertificate]
   * @param {string} [params.namespace]
   * @param {number} [params.timeoutMs=5000]
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async testConnection({ serverUrl, token, caCertificate, namespace, timeoutMs = 5000 } = {}) {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new BadRequestError('Authentication token is required to test Kubernetes connection');
    }

    const cleanToken = token.trim();
    const normalizedServerUrl = validateServerUrl(serverUrl);

    const testPath =
      namespace && namespace.trim()
        ? `/api/v1/namespaces/${encodeURIComponent(namespace.trim())}`
        : '/version';

    const targetUrl = `${normalizedServerUrl}${testPath}`;
    const agent = this._buildHttpsAgent(caCertificate);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          Accept: 'application/json',
        },
        agent,
        redirect: 'error',
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          success: false,
          message: 'Kubernetes authentication failed: Invalid or expired token',
        };
      }

      if (response.status === 403) {
        return {
          success: false,
          message: 'Kubernetes authorization failed: Forbidden access to cluster API',
        };
      }

      if (response.status === 404) {
        return {
          success: false,
          message: namespace
            ? `Kubernetes namespace '${namespace}' not found`
            : 'Kubernetes endpoint not found',
        };
      }

      if (!response.ok) {
        return {
          success: false,
          message: `Kubernetes API responded with HTTP status ${response.status}`,
        };
      }

      return {
        success: true,
        message: 'Kubernetes cluster connection successful',
      };
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return {
          success: false,
          message: 'Kubernetes connection timed out',
        };
      }
      return {
        success: false,
        message: sanitizeKubernetesErrorMessage(err.message, cleanToken),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fetch workload status from Kubernetes REST API.
   * Primary read-only endpoints:
   * - Deployments: /apis/apps/v1/namespaces/{namespace}/deployments/{name}
   * - StatefulSets: /apis/apps/v1/namespaces/{namespace}/statefulsets/{name}
   * - DaemonSets: /apis/apps/v1/namespaces/{namespace}/daemonsets/{name}
   * - Pods: /api/v1/namespaces/{namespace}/pods/{name}
   *
   * @param {object} params
   * @param {string} params.serverUrl
   * @param {string} params.token
   * @param {string} [params.caCertificate]
   * @param {string} [params.namespace='default']
   * @param {'deployment'|'statefulset'|'daemonset'|'pod'} [params.workloadType='deployment']
   * @param {string} params.workloadName
   * @param {number} [params.timeoutMs=5000]
   * @returns {Promise<object>} Normalized workload state
   */
  async fetchWorkloadStatus({
    serverUrl,
    token,
    caCertificate,
    namespace = 'default',
    workloadType = 'deployment',
    workloadName,
    timeoutMs = 5000,
  } = {}) {
    if (!workloadName || typeof workloadName !== 'string' || !workloadName.trim()) {
      throw new BadRequestError('Workload name is required to fetch Kubernetes status');
    }
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new BadRequestError('Authentication token is required to fetch Kubernetes status');
    }

    const cleanToken = token.trim();
    const cleanName = workloadName.trim();
    const cleanNs = (namespace && namespace.trim()) || 'default';
    const cleanType = String(workloadType).toLowerCase().trim();

    const allowedTypes = ['deployment', 'statefulset', 'daemonset', 'pod'];
    if (!allowedTypes.includes(cleanType)) {
      throw new BadRequestError(
        `Invalid workload type '${workloadType}'. Allowed: ${allowedTypes.join(', ')}`
      );
    }

    const normalizedServerUrl = validateServerUrl(serverUrl);

    let pathPrefix = '';
    switch (cleanType) {
      case 'deployment':
        pathPrefix = `/apis/apps/v1/namespaces/${encodeURIComponent(cleanNs)}/deployments/${encodeURIComponent(cleanName)}`;
        break;
      case 'statefulset':
        pathPrefix = `/apis/apps/v1/namespaces/${encodeURIComponent(cleanNs)}/statefulsets/${encodeURIComponent(cleanName)}`;
        break;
      case 'daemonset':
        pathPrefix = `/apis/apps/v1/namespaces/${encodeURIComponent(cleanNs)}/daemonsets/${encodeURIComponent(cleanName)}`;
        break;
      case 'pod':
        pathPrefix = `/api/v1/namespaces/${encodeURIComponent(cleanNs)}/pods/${encodeURIComponent(cleanName)}`;
        break;
    }

    const targetUrl = `${normalizedServerUrl}${pathPrefix}`;
    const agent = this._buildHttpsAgent(caCertificate);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          Accept: 'application/json',
        },
        agent,
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
          // Fallback if not JSON
        }
        const safeDetail = sanitizeKubernetesErrorMessage(errorDetail, cleanToken);
        throw new Error(`Kubernetes API returned ${response.status}: ${safeDetail}`);
      }

      const rawWorkload = await response.json();
      return this.normalizeWorkloadStatus(rawWorkload, {
        workloadType: cleanType,
        workloadName: cleanName,
        namespace: cleanNs,
      });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new Error('Kubernetes API request timed out');
      }
      const safeMessage = sanitizeKubernetesErrorMessage(err.message, cleanToken);
      throw new Error(`Kubernetes API request failed: ${safeMessage}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Normalizes raw Kubernetes workload data into the platform's vendor-agnostic schema.
   *
   * @param {object} rawWorkload
   * @param {object} [context]
   * @returns {object}
   */
  normalizeWorkloadStatus(rawWorkload, context = {}) {
    if (!rawWorkload || typeof rawWorkload !== 'object') {
      return {
        workloadType: context.workloadType || 'deployment',
        workloadName: context.workloadName || '',
        namespace: context.namespace || 'default',
        desiredReplicas: null,
        readyReplicas: null,
        availableReplicas: null,
        updatedReplicas: null,
        currentRevision: null,
        observedGeneration: null,
        generation: null,
        status: 'unknown',
        message: 'Workload data is empty or unavailable',
        containers: [],
      };
    }

    const kindLower = rawWorkload.kind ? String(rawWorkload.kind).toLowerCase() : '';
    const workloadType = context.workloadType || kindLower || 'deployment';
    const workloadName = rawWorkload.metadata?.name || context.workloadName || '';
    const namespace = rawWorkload.metadata?.namespace || context.namespace || 'default';

    const generation =
      rawWorkload.metadata?.generation !== undefined
        ? Number(rawWorkload.metadata.generation)
        : null;

    let desiredReplicas = null;
    let readyReplicas = null;
    let availableReplicas = null;
    let updatedReplicas = null;
    let currentRevision = null;
    let observedGeneration = null;
    let healthResult = { status: 'unknown', message: 'Status unknown' };
    let containers = [];

    switch (workloadType) {
      case 'deployment': {
        desiredReplicas =
          rawWorkload.spec?.replicas !== undefined ? Number(rawWorkload.spec.replicas) : 1;
        readyReplicas =
          rawWorkload.status?.readyReplicas !== undefined
            ? Number(rawWorkload.status.readyReplicas)
            : 0;
        availableReplicas =
          rawWorkload.status?.availableReplicas !== undefined
            ? Number(rawWorkload.status.availableReplicas)
            : 0;
        updatedReplicas =
          rawWorkload.status?.updatedReplicas !== undefined
            ? Number(rawWorkload.status.updatedReplicas)
            : 0;
        currentRevision =
          rawWorkload.metadata?.annotations?.['deployment.kubernetes.io/revision'] || null;
        observedGeneration =
          rawWorkload.status?.observedGeneration !== undefined
            ? Number(rawWorkload.status.observedGeneration)
            : null;

        const specContainers = rawWorkload.spec?.template?.spec?.containers || [];
        containers = specContainers.map((c) => ({
          name: c.name || '',
          image: c.image || null,
          ready: null,
          restartCount: null,
          state: null,
        }));

        healthResult = interpretDeploymentHealth(
          rawWorkload,
          desiredReplicas,
          readyReplicas,
          availableReplicas,
          updatedReplicas
        );
        break;
      }

      case 'statefulset': {
        desiredReplicas =
          rawWorkload.spec?.replicas !== undefined ? Number(rawWorkload.spec.replicas) : 1;
        readyReplicas =
          rawWorkload.status?.readyReplicas !== undefined
            ? Number(rawWorkload.status.readyReplicas)
            : 0;
        availableReplicas =
          rawWorkload.status?.availableReplicas !== undefined
            ? Number(rawWorkload.status.availableReplicas)
            : readyReplicas;
        updatedReplicas =
          rawWorkload.status?.updatedReplicas !== undefined
            ? Number(rawWorkload.status.updatedReplicas)
            : 0;
        currentRevision = rawWorkload.status?.currentRevision || null;
        observedGeneration =
          rawWorkload.status?.observedGeneration !== undefined
            ? Number(rawWorkload.status.observedGeneration)
            : null;

        const specContainers = rawWorkload.spec?.template?.spec?.containers || [];
        containers = specContainers.map((c) => ({
          name: c.name || '',
          image: c.image || null,
          ready: null,
          restartCount: null,
          state: null,
        }));

        healthResult = interpretStatefulSetHealth(
          rawWorkload,
          desiredReplicas,
          readyReplicas,
          updatedReplicas
        );
        break;
      }

      case 'daemonset': {
        desiredReplicas =
          rawWorkload.status?.desiredNumberScheduled !== undefined
            ? Number(rawWorkload.status.desiredNumberScheduled)
            : 0;
        readyReplicas =
          rawWorkload.status?.numberReady !== undefined
            ? Number(rawWorkload.status.numberReady)
            : 0;
        availableReplicas =
          rawWorkload.status?.numberAvailable !== undefined
            ? Number(rawWorkload.status.numberAvailable)
            : readyReplicas;
        updatedReplicas =
          rawWorkload.status?.updatedNumberScheduled !== undefined
            ? Number(rawWorkload.status.updatedNumberScheduled)
            : 0;
        currentRevision = null;
        observedGeneration =
          rawWorkload.status?.observedGeneration !== undefined
            ? Number(rawWorkload.status.observedGeneration)
            : null;

        const specContainers = rawWorkload.spec?.template?.spec?.containers || [];
        containers = specContainers.map((c) => ({
          name: c.name || '',
          image: c.image || null,
          ready: null,
          restartCount: null,
          state: null,
        }));

        const unavailable =
          rawWorkload.status?.numberUnavailable !== undefined
            ? Number(rawWorkload.status.numberUnavailable)
            : 0;

        healthResult = interpretDaemonSetHealth(
          rawWorkload,
          desiredReplicas,
          readyReplicas,
          unavailable
        );
        break;
      }

      case 'pod': {
        desiredReplicas = 1;
        const containerStatuses = Array.isArray(rawWorkload.status?.containerStatuses)
          ? rawWorkload.status.containerStatuses
          : [];
        const specContainers = Array.isArray(rawWorkload.spec?.containers)
          ? rawWorkload.spec.containers
          : [];

        containers = specContainers.map((spec) => {
          const cs = containerStatuses.find((c) => c.name === spec.name) || {};
          let state = null;
          if (cs.state?.running) state = 'running';
          else if (cs.state?.waiting) state = `waiting:${cs.state.waiting.reason || ''}`;
          else if (cs.state?.terminated)
            state = `terminated:${cs.state.terminated.reason || cs.state.terminated.exitCode}`;

          return {
            name: spec.name || '',
            image: spec.image || cs.image || null,
            ready: cs.ready !== undefined ? Boolean(cs.ready) : null,
            restartCount: cs.restartCount !== undefined ? Number(cs.restartCount) : null,
            state,
          };
        });

        healthResult = interpretPodHealth(rawWorkload);
        readyReplicas = healthResult.status === 'healthy' ? 1 : 0;
        availableReplicas = readyReplicas;
        updatedReplicas = 1;
        currentRevision = null;
        observedGeneration = null;
        break;
      }
    }

    return {
      workloadType,
      workloadName,
      namespace,
      desiredReplicas,
      readyReplicas,
      availableReplicas,
      updatedReplicas,
      currentRevision,
      observedGeneration,
      generation,
      status: healthResult.status,
      message: healthResult.message,
      containers,
    };
  }

  /**
   * Detect runtime divergence and rollout drift from normalized or raw workload.
   *
   * @param {object} workload
   * @returns {{ hasDrift: boolean, reasons: Array<string> }}
   */
  detectDrift(workload) {
    if (!workload) {
      return { hasDrift: false, reasons: [] };
    }

    const normalized = workload.workloadType ? workload : this.normalizeWorkloadStatus(workload);
    const reasons = [];

    // 1. Generation vs observedGeneration divergence
    if (
      normalized.generation !== null &&
      normalized.observedGeneration !== null &&
      normalized.generation !== normalized.observedGeneration
    ) {
      reasons.push(
        `Observed generation (${normalized.observedGeneration}) does not match generation (${normalized.generation})`
      );
    }

    // 2. Replicas convergence divergence
    if (normalized.desiredReplicas !== null && normalized.desiredReplicas > 0) {
      if (
        normalized.readyReplicas !== null &&
        normalized.readyReplicas < normalized.desiredReplicas
      ) {
        reasons.push(
          `Ready replicas (${normalized.readyReplicas}) less than desired (${normalized.desiredReplicas})`
        );
      }
      if (
        normalized.availableReplicas !== null &&
        normalized.availableReplicas < normalized.desiredReplicas
      ) {
        reasons.push(
          `Available replicas (${normalized.availableReplicas}) less than desired (${normalized.desiredReplicas})`
        );
      }
      if (
        normalized.updatedReplicas !== null &&
        normalized.updatedReplicas < normalized.desiredReplicas
      ) {
        reasons.push(
          `Updated replicas (${normalized.updatedReplicas}) less than desired (${normalized.desiredReplicas})`
        );
      }
    }

    // 3. Degraded workload state
    if (normalized.status === 'degraded') {
      reasons.push(
        `Workload status is degraded: ${normalized.message || 'Failure condition detected'}`
      );
    }

    return {
      hasDrift: reasons.length > 0,
      reasons,
    };
  }
}

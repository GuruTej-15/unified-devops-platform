import { DEPLOYMENT_STATUS, ORCHESTRATION_HEALTH_STATUS } from '../../shared/constants.js';

/**
 * Deterministically maps normalized orchestration health, sync, and runtime state
 * into the authoritative deployment status model.
 *
 * Mapping Rules:
 * - healthy -> DEPLOYMENT_STATUS.SUCCESS
 * - progressing / runtime.operationPhase === 'Running' -> DEPLOYMENT_STATUS.IN_PROGRESS
 * - degraded / runtime.operationPhase === 'Failed' | 'Error' -> DEPLOYMENT_STATUS.FAILED
 * - missing -> DEPLOYMENT_STATUS.FAILED
 * - suspended -> DEPLOYMENT_STATUS.CANCELLED
 * - runtime.operationPhase === 'Initiated' | 'Queued' -> DEPLOYMENT_STATUS.QUEUED
 * - unknown / fallback -> DEPLOYMENT_STATUS.UNKNOWN
 *
 * @param {object} observation
 * @returns {string} Deployment status enum value
 */
export function mapObservationToDeploymentStatus(observation = {}) {
  const healthStatus =
    observation.health?.status || observation.status || ORCHESTRATION_HEALTH_STATUS.UNKNOWN;
  const operationPhase = observation.runtime?.operationPhase;

  // 1. Explicit operation failures take precedence
  if (operationPhase === 'Failed' || operationPhase === 'Error') {
    return DEPLOYMENT_STATUS.FAILED;
  }

  // 2. Active operation or progressing state
  if (operationPhase === 'Running' || healthStatus === ORCHESTRATION_HEALTH_STATUS.PROGRESSING) {
    return DEPLOYMENT_STATUS.IN_PROGRESS;
  }

  // 3. Healthy workloads represent a successful deployment projection
  if (healthStatus === ORCHESTRATION_HEALTH_STATUS.HEALTHY) {
    return DEPLOYMENT_STATUS.SUCCESS;
  }

  // 4. Degraded workload state
  if (healthStatus === ORCHESTRATION_HEALTH_STATUS.DEGRADED) {
    return DEPLOYMENT_STATUS.FAILED;
  }

  // 5. Missing / deleted workload
  if (healthStatus === ORCHESTRATION_HEALTH_STATUS.MISSING) {
    return DEPLOYMENT_STATUS.FAILED;
  }

  // 6. Suspended workload
  if (healthStatus === ORCHESTRATION_HEALTH_STATUS.SUSPENDED) {
    return DEPLOYMENT_STATUS.CANCELLED;
  }

  // 7. Queued or initiated operations
  if (operationPhase === 'Initiated' || operationPhase === 'Queued') {
    return DEPLOYMENT_STATUS.QUEUED;
  }

  // 8. Default fallback
  return DEPLOYMENT_STATUS.UNKNOWN;
}

export default {
  mapObservationToDeploymentStatus,
};

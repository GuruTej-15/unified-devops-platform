/**
 * Abstract Base Orchestration Provider interface.
 * All orchestration providers (Argo CD, Kubernetes) implement this contract.
 */
export default class BaseOrchestrationProvider {
  /**
   * Return the provider identifier string (e.g. 'argocd', 'kubernetes').
   * @returns {string}
   */
  getProviderName() {
    throw new Error('getProviderName() must be implemented by subclass');
  }

  /**
   * Test connection to the orchestration provider.
   * @param {object} params
   * @returns {Promise<object|boolean>}
   */
  async testConnection(_params = {}) {
    throw new Error('testConnection() must be implemented by subclass');
  }

  /**
   * Fetch workload/application status from the provider's remote REST API.
   * @param {object} params
   * @returns {Promise<object>}
   */
  async fetchWorkloadStatus(_params = {}) {
    throw new Error('fetchWorkloadStatus() must be implemented by subclass');
  }

  /**
   * Normalize raw provider workload/application data into standard platform format.
   * @param {object} rawWorkload
   * @param {object} [context]
   * @returns {object}
   */
  normalizeWorkloadStatus(_rawWorkload, _context = {}) {
    throw new Error('normalizeWorkloadStatus() must be implemented by subclass');
  }

  /**
   * Detect drift and identify out-of-sync resources from workload state.
   * @param {object} workload
   * @returns {{ hasDrift: boolean, outOfSyncResources: Array<object> }}
   */
  detectDrift(_workload) {
    throw new Error('detectDrift() must be implemented by subclass');
  }
}

import ArgoCDProvider from './argoCDProvider.js';
import { ORCHESTRATION_PROVIDER } from '../../../shared/constants.js';

const providers = new Map();

// Initialize default providers (only argocd in Step 2; kubernetes will be added in future steps)
const defaultArgoCDProvider = new ArgoCDProvider();
providers.set(ORCHESTRATION_PROVIDER.ARGOCD, defaultArgoCDProvider);

/**
 * Validates that a provider instance conforms to BaseOrchestrationProvider contract.
 *
 * @param {object} providerInstance
 */
function validateProviderContract(providerInstance) {
  if (!providerInstance || typeof providerInstance !== 'object') {
    throw new Error('Provider instance must be a non-null object');
  }

  const requiredMethods = [
    'getProviderName',
    'testConnection',
    'fetchWorkloadStatus',
    'normalizeWorkloadStatus',
    'detectDrift',
  ];

  for (const method of requiredMethods) {
    if (typeof providerInstance[method] !== 'function') {
      throw new Error(`Provider instance must implement method '${method}'`);
    }
  }
}

/**
 * Get an orchestration provider adapter by provider identifier.
 *
 * @param {string} providerName - e.g. 'argocd'
 * @returns {import('./baseOrchestrationProvider.js').default}
 */
export function getOrchestrationProvider(providerName) {
  if (!providerName || typeof providerName !== 'string') {
    throw new Error(
      `Invalid provider name: '${providerName}'. Provider name must be a non-empty string.`
    );
  }

  const normalized = providerName.trim().toLowerCase();
  const provider = providers.get(normalized);

  if (!provider) {
    throw new Error(
      `Unsupported orchestration provider: '${providerName}'. Registered providers: ${Array.from(
        providers.keys()
      ).join(', ')}`
    );
  }

  return provider;
}

/**
 * Register a custom or mock orchestration provider instance.
 *
 * @param {string} name
 * @param {object} providerInstance
 */
export function registerOrchestrationProvider(name, providerInstance) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Provider registration requires a non-empty string name');
  }

  validateProviderContract(providerInstance);
  providers.set(name.trim().toLowerCase(), providerInstance);
}

/**
 * Check if a provider name is registered.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function hasOrchestrationProvider(name) {
  if (!name || typeof name !== 'string') return false;
  return providers.has(name.trim().toLowerCase());
}

/**
 * Resets the provider registry to default state (helper for test cleanup).
 */
export function _resetOrchestrationProviderRegistry() {
  providers.clear();
  providers.set(ORCHESTRATION_PROVIDER.ARGOCD, defaultArgoCDProvider);
}

export { defaultArgoCDProvider };

import TrivyProvider from './trivyProvider.js';
import { SECURITY_PROVIDER } from '../../../shared/constants.js';

const providers = new Map();

// Initialize default providers
const defaultTrivyProvider = new TrivyProvider();
providers.set(SECURITY_PROVIDER.TRIVY, defaultTrivyProvider);

/**
 * Validates that a provider instance conforms to BaseSecurityProvider contract.
 *
 * @param {object} providerInstance
 */
function validateProviderContract(providerInstance) {
  if (!providerInstance || typeof providerInstance !== 'object') {
    throw new Error('Provider instance must be a non-null object');
  }

  const requiredMethods = ['getProviderName', 'parseReport', 'extractScanMetadata'];
  for (const method of requiredMethods) {
    if (typeof providerInstance[method] !== 'function') {
      throw new Error(`Provider instance must implement method '${method}'`);
    }
  }
}

/**
 * Get a security provider adapter by provider identifier.
 *
 * @param {string} providerName - e.g. 'trivy'
 * @returns {BaseSecurityProvider}
 */
export function getSecurityProvider(providerName) {
  if (!providerName || typeof providerName !== 'string') {
    throw new Error(
      `Invalid provider name: '${providerName}'. Provider name must be a non-empty string.`
    );
  }

  const normalized = providerName.trim().toLowerCase();
  const provider = providers.get(normalized);

  if (!provider) {
    throw new Error(
      `Unsupported security provider: '${providerName}'. Registered providers: ${Array.from(providers.keys()).join(', ')}`
    );
  }

  return provider;
}

/**
 * Register a custom or mock security provider instance.
 *
 * @param {string} name
 * @param {BaseSecurityProvider} providerInstance
 */
export function registerSecurityProvider(name, providerInstance) {
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
export function hasSecurityProvider(name) {
  if (!name || typeof name !== 'string') return false;
  return providers.has(name.trim().toLowerCase());
}

/**
 * Resets the provider registry to default state (helper for tests).
 */
export function _resetSecurityProviderRegistry() {
  providers.clear();
  providers.set(SECURITY_PROVIDER.TRIVY, defaultTrivyProvider);
}

export { defaultTrivyProvider };

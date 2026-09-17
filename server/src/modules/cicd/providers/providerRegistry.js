import GitHubActionsProvider from './githubActionsProvider.js';
import JenkinsProvider from './jenkinsProvider.js';
import { CI_PROVIDER } from '../../../shared/constants.js';

const providers = new Map();

// Initialize default providers
const defaultGitHubProvider = new GitHubActionsProvider();
const defaultJenkinsProvider = new JenkinsProvider();

providers.set(CI_PROVIDER.GITHUB_ACTIONS, defaultGitHubProvider);
providers.set(CI_PROVIDER.JENKINS, defaultJenkinsProvider);

/**
 * Get CI provider adapter by provider identifier.
 * Defaults to GitHub Actions provider for backward compatibility.
 * @param {string} [providerName]
 * @returns {import('./baseCiProvider.js').default}
 */
export function getCiProvider(providerName) {
  if (!providerName) {
    return defaultGitHubProvider;
  }

  const normalized = String(providerName).toLowerCase();
  const provider = providers.get(normalized);

  if (provider) {
    return provider;
  }

  return defaultGitHubProvider;
}

/**
 * Register a custom or mock provider instance.
 */
export function registerCiProvider(name, providerInstance) {
  providers.set(name.toLowerCase(), providerInstance);
}

export { defaultGitHubProvider, defaultJenkinsProvider };

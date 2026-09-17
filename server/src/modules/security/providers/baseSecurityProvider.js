/**
 * Abstract Base Security Provider interface.
 * All security providers (e.g. Trivy) implement this contract.
 */
export default class BaseSecurityProvider {
  /**
   * Return the provider identifier string (e.g. 'trivy').
   * @returns {string}
   */
  getProviderName() {
    throw new Error('getProviderName() must be implemented by subclass');
  }

  /**
   * Parse a raw scan report into normalized findings, summary counts, and provider metadata.
   *
   * @param {string|object} rawReport - Raw report as JSON string or parsed object
   * @param {object} [context] - Contextual metadata { repositoryId, projectId, scanType, target }
   * @returns {Promise<{ findings: Array<object>, summary: object, providerMetadata: object }>|{ findings: Array<object>, summary: object, providerMetadata: object }}
   */
  parseReport(_rawReport, _context = {}) {
    throw new Error('parseReport() must be implemented by subclass');
  }

  /**
   * Extract top-level scan metadata (target, scanType, providerMetadata) from the report.
   *
   * @param {string|object} rawReport
   * @param {object} [context]
   * @returns {object}
   */
  extractScanMetadata(_rawReport, _context = {}) {
    throw new Error('extractScanMetadata() must be implemented by subclass');
  }
}

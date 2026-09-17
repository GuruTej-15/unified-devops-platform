/**
 * Abstract Base CI Provider interface.
 * All CI providers (GitHub Actions, Jenkins) implement this contract.
 */
export default class BaseCiProvider {
  /**
   * Return the provider identifier string (e.g. 'github_actions', 'jenkins').
   * @returns {string}
   */
  getProviderName() {
    throw new Error('getProviderName() must be implemented by subclass');
  }

  /**
   * Verify the authenticity of an incoming webhook request.
   * @param {import('express').Request} req
   * @param {object} [context]
   * @returns {boolean|Promise<boolean>}
   */
  verifyWebhookSignature(_req, _context = {}) {
    throw new Error('verifyWebhookSignature() must be implemented by subclass');
  }

  /**
   * Extract delivery metadata (deliveryId, event, action, etc.) from incoming request.
   * @param {import('express').Request} req
   * @param {object} [context]
   * @returns {object|Promise<object>}
   */
  extractDeliveryMetadata(_req, _context = {}) {
    throw new Error('extractDeliveryMetadata() must be implemented by subclass');
  }

  /**
   * Normalize the raw webhook payload into standard platform PipelineRun data.
   * @param {object} payload
   * @param {object} metadata
   * @param {object} context
   * @returns {Promise<object>}
   */
  normalizeWebhookPayload(_payload, _metadata = {}, _context = {}) {
    throw new Error('normalizeWebhookPayload() must be implemented by subclass');
  }

  /**
   * Reconcile pipeline runs from the provider's remote REST API.
   * @param {object} params
   * @returns {Promise<Array<object>>}
   */
  reconcileRuns(_params = {}) {
    throw new Error('reconcileRuns() must be implemented by subclass');
  }
}

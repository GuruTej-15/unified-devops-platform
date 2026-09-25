import mongoose from 'mongoose';
import OrchestrationIntegration from './orchestrationIntegration.model.js';
import {
  ORCHESTRATION_PROVIDER,
  ORCHESTRATION_PROVIDER_VALUES,
  DEPLOYMENT_ENVIRONMENT,
  DEPLOYMENT_ENVIRONMENT_VALUES,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
} from '../../shared/constants.js';
import { encrypt, maskToken } from '../../shared/crypto.js';
import { validateServerUrl } from '../../shared/urlValidator.js';
import AuditService from '../audit/audit.service.js';
import { sendSuccess, sendCreated } from '../../shared/apiResponse.js';
import { BadRequestError, NotFoundError, ConflictError } from '../../shared/errors.js';
import logger from '../../shared/logger.js';

/**
 * Strips all sensitive credentials, IVs, tags, and CA certificates
 * from the orchestration integration model before sending it over the API.
 *
 * @param {object} doc - OrchestrationIntegration document
 * @returns {object} Safe integration representation
 */
export function formatIntegration(doc) {
  return {
    _id: doc._id,
    project: doc.project,
    name: doc.name,
    provider: doc.provider,
    environment: doc.environment,
    serverUrl: doc.serverUrl,
    status: doc.status,
    namespace: doc.namespace ?? null,
    applicationName: doc.applicationName ?? null,
    tokenHint: doc.tokenHint ?? '',
    lastHealthCheckAt: doc.lastHealthCheckAt,
    lastErrorMessage: doc.lastErrorMessage,
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * POST /api/v1/projects/:projectId/orchestration/integrations
 * Create a new Kubernetes or Argo CD integration.
 */
export async function createOrchestrationIntegration(req, res) {
  const { projectId } = req.params;
  const {
    name,
    provider,
    environment = DEPLOYMENT_ENVIRONMENT.PRODUCTION,
    serverUrl,
    token,
    namespace,
    caCertificate,
    applicationName,
  } = req.body || {};

  // 1. Basic field presence and type validation
  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
    throw new BadRequestError(
      'Integration name is required and must be between 2 and 100 characters'
    );
  }

  if (!provider || !ORCHESTRATION_PROVIDER_VALUES.includes(provider)) {
    throw new BadRequestError(
      `Invalid provider '${provider}'. Allowed values: ${ORCHESTRATION_PROVIDER_VALUES.join(', ')}`
    );
  }

  if (environment && !DEPLOYMENT_ENVIRONMENT_VALUES.includes(environment)) {
    throw new BadRequestError(
      `Invalid environment '${environment}'. Allowed values: ${DEPLOYMENT_ENVIRONMENT_VALUES.join(', ')}`
    );
  }

  if (!token || typeof token !== 'string' || token.trim().length < 10) {
    throw new BadRequestError('A valid authentication token is required (minimum 10 characters)');
  }

  // 2. SSRF Protection: Validate server URL
  const normalizedServerUrl = validateServerUrl(serverUrl);

  // 3. Provider-specific configuration validation
  let finalNamespace = null;
  let finalCaCertificate = null;
  let finalApplicationName = null;

  if (provider === ORCHESTRATION_PROVIDER.KUBERNETES) {
    if (
      applicationName !== undefined &&
      applicationName !== null &&
      String(applicationName).trim() !== ''
    ) {
      throw new BadRequestError('Field applicationName is not supported for kubernetes provider');
    }
    if (namespace !== undefined && namespace !== null && typeof namespace !== 'string') {
      throw new BadRequestError('Namespace must be a valid string');
    }
    finalNamespace = namespace ? namespace.trim() : 'default';
    if (caCertificate) {
      if (typeof caCertificate !== 'string') {
        throw new BadRequestError('CA certificate must be a valid string');
      }
      finalCaCertificate = caCertificate.trim();
    }
  } else if (provider === ORCHESTRATION_PROVIDER.ARGOCD) {
    if (namespace !== undefined && namespace !== null && String(namespace).trim() !== '') {
      throw new BadRequestError('Field namespace is not supported for argocd provider');
    }
    if (
      caCertificate !== undefined &&
      caCertificate !== null &&
      String(caCertificate).trim() !== ''
    ) {
      throw new BadRequestError('Field caCertificate is not supported for argocd provider');
    }
    if (applicationName !== undefined && applicationName !== null) {
      if (typeof applicationName !== 'string' || applicationName.trim().length === 0) {
        throw new BadRequestError('applicationName must be a non-empty string');
      }
      finalApplicationName = applicationName.trim();
    }
  }

  // 4. Duplicate name check within the same project
  const existing = await OrchestrationIntegration.findOne({
    project: projectId,
    name: name.trim(),
  });
  if (existing) {
    throw new ConflictError(
      `An orchestration integration named '${name.trim()}' already exists in this project`
    );
  }

  // 5. Encrypt token at rest using AES-256-GCM
  const cleanToken = token.trim();
  const enc = encrypt(cleanToken);

  // 6. Persist to MongoDB
  const integration = await OrchestrationIntegration.create({
    project: projectId,
    name: name.trim(),
    provider,
    environment,
    serverUrl: normalizedServerUrl,
    namespace: finalNamespace,
    caCertificate: finalCaCertificate,
    applicationName: finalApplicationName,
    encryptedToken: enc.ciphertext,
    tokenIv: enc.iv,
    tokenAuthTag: enc.authTag,
    tokenHint: maskToken(cleanToken),
    createdBy: req.user.id,
  });

  // 7. Audit log with safe metadata ONLY (NEVER log tokens, keys, or certs)
  AuditService.log({
    action: AUDIT_ACTIONS.ORCHESTRATION_INTEGRATION_CREATED,
    actor: req.user.id,
    entityType: ENTITY_TYPES.ORCHESTRATION_INTEGRATION,
    entityId: integration._id,
    projectId,
    metadata: {
      name: integration.name,
      provider: integration.provider,
      environment: integration.environment,
      serverUrl: integration.serverUrl,
      namespace: integration.namespace,
      applicationName: integration.applicationName,
    },
  }).catch((err) => logger.warn(`Audit log write failed: ${err.message}`));

  return sendCreated(res, {
    message: 'Orchestration integration created successfully',
    data: formatIntegration(integration),
  });
}

/**
 * GET /api/v1/projects/:projectId/orchestration/integrations
 * List orchestration integrations for a project with optional filters.
 */
export async function listOrchestrationIntegrations(req, res) {
  const { projectId } = req.params;
  const { provider, environment } = req.query;

  const filter = { project: projectId };

  if (provider) {
    if (!ORCHESTRATION_PROVIDER_VALUES.includes(provider)) {
      throw new BadRequestError(`Invalid provider filter: '${provider}'`);
    }
    filter.provider = provider;
  }

  if (environment) {
    if (!DEPLOYMENT_ENVIRONMENT_VALUES.includes(environment)) {
      throw new BadRequestError(`Invalid environment filter: '${environment}'`);
    }
    filter.environment = environment;
  }

  const integrations = await OrchestrationIntegration.find(filter).sort({ createdAt: -1 });

  return sendSuccess(res, {
    data: integrations.map(formatIntegration),
  });
}

/**
 * GET /api/v1/projects/:projectId/orchestration/integrations/:integrationId
 * Get a specific integration by ID.
 */
export async function getOrchestrationIntegration(req, res) {
  const { projectId, integrationId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(integrationId)) {
    throw new NotFoundError('Orchestration integration not found');
  }

  const integration = await OrchestrationIntegration.findOne({
    _id: integrationId,
    project: projectId,
  });

  if (!integration) {
    throw new NotFoundError('Orchestration integration not found');
  }

  return sendSuccess(res, {
    data: formatIntegration(integration),
  });
}

/**
 * PATCH /api/v1/projects/:projectId/orchestration/integrations/:integrationId
 * Update integration metadata or credentials.
 */
export async function updateOrchestrationIntegration(req, res) {
  const { projectId, integrationId } = req.params;
  const { name, environment, serverUrl, token, namespace, caCertificate, applicationName } =
    req.body || {};

  if (!mongoose.Types.ObjectId.isValid(integrationId)) {
    throw new NotFoundError('Orchestration integration not found');
  }

  const integration = await OrchestrationIntegration.findOne({
    _id: integrationId,
    project: projectId,
  });

  if (!integration) {
    throw new NotFoundError('Orchestration integration not found');
  }

  // 1. Name update and uniqueness validation
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
      throw new BadRequestError('Integration name must be between 2 and 100 characters');
    }
    const duplicate = await OrchestrationIntegration.findOne({
      project: projectId,
      name: name.trim(),
      _id: { $ne: integration._id },
    });
    if (duplicate) {
      throw new ConflictError(
        `An orchestration integration named '${name.trim()}' already exists in this project`
      );
    }
    integration.name = name.trim();
  }

  // 2. Environment update
  if (environment !== undefined) {
    if (!DEPLOYMENT_ENVIRONMENT_VALUES.includes(environment)) {
      throw new BadRequestError(`Invalid environment: '${environment}'`);
    }
    integration.environment = environment;
  }

  // 3. Server URL update (SSRF checked)
  if (serverUrl !== undefined) {
    integration.serverUrl = validateServerUrl(serverUrl);
  }

  // 4. Token update
  if (token !== undefined) {
    if (typeof token !== 'string' || token.trim().length < 10) {
      throw new BadRequestError('Token must be a valid string of at least 10 characters');
    }
    const cleanToken = token.trim();
    const enc = encrypt(cleanToken);
    integration.encryptedToken = enc.ciphertext;
    integration.tokenIv = enc.iv;
    integration.tokenAuthTag = enc.authTag;
    integration.tokenHint = maskToken(cleanToken);
  }

  // 5. Provider-specific configuration updates
  if (integration.provider === ORCHESTRATION_PROVIDER.KUBERNETES) {
    if (
      applicationName !== undefined &&
      applicationName !== null &&
      String(applicationName).trim() !== ''
    ) {
      throw new BadRequestError('Field applicationName is not supported for kubernetes provider');
    }
    if (namespace !== undefined) {
      if (typeof namespace !== 'string' || namespace.trim().length === 0) {
        throw new BadRequestError('Namespace must be a non-empty string');
      }
      integration.namespace = namespace.trim();
    }
    if (caCertificate !== undefined) {
      integration.caCertificate = caCertificate ? String(caCertificate).trim() : null;
    }
  } else if (integration.provider === ORCHESTRATION_PROVIDER.ARGOCD) {
    if (namespace !== undefined && namespace !== null && String(namespace).trim() !== '') {
      throw new BadRequestError('Field namespace is not supported for argocd provider');
    }
    if (
      caCertificate !== undefined &&
      caCertificate !== null &&
      String(caCertificate).trim() !== ''
    ) {
      throw new BadRequestError('Field caCertificate is not supported for argocd provider');
    }
    if (applicationName !== undefined) {
      integration.applicationName = applicationName ? String(applicationName).trim() : null;
    }
  }

  integration.updatedBy = req.user.id;
  await integration.save();

  // 6. Audit log with safe metadata
  AuditService.log({
    action: AUDIT_ACTIONS.ORCHESTRATION_INTEGRATION_UPDATED,
    actor: req.user.id,
    entityType: ENTITY_TYPES.ORCHESTRATION_INTEGRATION,
    entityId: integration._id,
    projectId,
    metadata: {
      name: integration.name,
      provider: integration.provider,
      environment: integration.environment,
      serverUrl: integration.serverUrl,
      namespace: integration.namespace,
      applicationName: integration.applicationName,
    },
  }).catch((err) => logger.warn(`Audit log write failed: ${err.message}`));

  return sendSuccess(res, {
    message: 'Orchestration integration updated successfully',
    data: formatIntegration(integration),
  });
}

/**
 * DELETE /api/v1/projects/:projectId/orchestration/integrations/:integrationId
 * Delete an orchestration integration.
 */
export async function deleteOrchestrationIntegration(req, res) {
  const { projectId, integrationId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(integrationId)) {
    throw new NotFoundError('Orchestration integration not found');
  }

  const deleted = await OrchestrationIntegration.findOneAndDelete({
    _id: integrationId,
    project: projectId,
  });

  if (!deleted) {
    throw new NotFoundError('Orchestration integration not found');
  }

  AuditService.log({
    action: AUDIT_ACTIONS.ORCHESTRATION_INTEGRATION_DELETED,
    actor: req.user.id,
    entityType: ENTITY_TYPES.ORCHESTRATION_INTEGRATION,
    entityId: integrationId,
    projectId,
    metadata: {
      name: deleted.name,
      provider: deleted.provider,
      environment: deleted.environment,
    },
  }).catch((err) => logger.warn(`Audit log write failed: ${err.message}`));

  return sendSuccess(res, {
    message: 'Orchestration integration deleted successfully',
  });
}

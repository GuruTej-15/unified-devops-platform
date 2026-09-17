import crypto from 'node:crypto';
import mongoose from 'mongoose';
import SecurityIntegration from './securityIntegration.model.js';
import SecurityDelivery from './securityDelivery.model.js';
import Repository from '../vcs/repository.model.js';
import PipelineRun from '../cicd/pipelineRun.model.js';
import { hasSecurityProvider } from './providers/securityProviderRegistry.js';
import { enqueueSecurityScanJob } from './securityQueue.js';
import { SECURITY_PROVIDER_VALUES, AUDIT_ACTIONS, ENTITY_TYPES } from '../../shared/constants.js';
import { encrypt, decrypt, maskToken } from '../../shared/crypto.js';
import AuditService from '../audit/audit.service.js';
import { sendSuccess, sendCreated } from '../../shared/apiResponse.js';
import logger from '../../shared/logger.js';

/**
 * Constant-time comparison for security tokens to prevent timing attacks.
 *
 * @param {string} providedToken
 * @param {string} expectedSecret
 * @returns {boolean}
 */
export function verifySecurityToken(providedToken, expectedSecret) {
  if (!providedToken || !expectedSecret) {
    return false;
  }

  try {
    const provBuf = Buffer.from(String(providedToken), 'utf8');
    const expBuf = Buffer.from(String(expectedSecret), 'utf8');

    if (provBuf.length !== expBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(provBuf, expBuf);
  } catch (err) {
    logger.error('Token verification timing error:', err.message);
    return false;
  }
}

/**
 * Format a SecurityIntegration document for API responses.
 * Never includes raw or encrypted secrets.
 */
function formatIntegration(doc) {
  return {
    _id: doc._id,
    project: doc.project,
    repository: doc.repository,
    name: doc.name,
    provider: doc.provider,
    isActive: doc.isActive,
    ingestionSecretHint: doc.ingestionSecretHint,
    webhookUrl: `/api/v1/webhooks/security/${doc._id}`,
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * POST /api/v1/projects/:projectId/security/integrations
 * Create a new SecurityIntegration with server-generated encrypted secret.
 */
export async function createSecurityIntegration(req, res) {
  const { projectId } = req.params;
  const { name, provider = 'trivy', repositoryId } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
    return res.status(400).json({
      success: false,
      message: 'Integration name is required and must be between 2 and 100 characters',
    });
  }

  if (!SECURITY_PROVIDER_VALUES.includes(provider)) {
    return res.status(400).json({
      success: false,
      message: `Invalid provider '${provider}'. Allowed values: ${SECURITY_PROVIDER_VALUES.join(', ')}`,
    });
  }

  // Validate optional repository scoping
  if (repositoryId) {
    if (!mongoose.Types.ObjectId.isValid(repositoryId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid repositoryId format',
      });
    }

    const repoExists = await Repository.findOne({ _id: repositoryId, project: projectId });
    if (!repoExists) {
      return res.status(400).json({
        success: false,
        message: 'Repository not found or does not belong to this project',
      });
    }
  }

  // Check for duplicate name in project
  const existing = await SecurityIntegration.findOne({
    project: projectId,
    name: name.trim(),
  });
  if (existing) {
    return res.status(409).json({
      success: false,
      message: `A security integration named '${name.trim()}' already exists in this project`,
    });
  }

  // Generate cryptographically secure 32-byte (64 hex char) ingestion secret
  const rawSecret = crypto.randomBytes(32).toString('hex');
  const encSecret = encrypt(rawSecret);

  const integration = await SecurityIntegration.create({
    project: projectId,
    repository: repositoryId || null,
    name: name.trim(),
    provider,
    encryptedIngestionSecret: encSecret.ciphertext,
    ingestionSecretIv: encSecret.iv,
    ingestionSecretAuthTag: encSecret.authTag,
    ingestionSecretHint: maskToken(rawSecret),
    createdBy: req.user.id,
  });

  await AuditService.log({
    action: AUDIT_ACTIONS.SECURITY_INTEGRATION_CREATED,
    actor: req.user.id,
    entityType: ENTITY_TYPES.SECURITY_INTEGRATION,
    entityId: integration._id,
    projectId,
    metadata: {
      name: integration.name,
      provider: integration.provider,
      repositoryId: integration.repository,
    },
  });

  return sendCreated(res, {
    message: 'Security integration created successfully',
    data: {
      ...formatIntegration(integration),
      // Raw secret is displayed ONCE on creation and never stored/retrievable again
      ingestionSecret: rawSecret,
    },
  });
}

/**
 * GET /api/v1/projects/:projectId/security/integrations
 * List all security integrations for a project.
 */
export async function listSecurityIntegrations(req, res) {
  const { projectId } = req.params;

  const integrations = await SecurityIntegration.find({ project: projectId })
    .populate('repository', 'name fullName defaultBranch htmlUrl')
    .sort({ createdAt: -1 });

  return sendSuccess(res, {
    data: integrations.map(formatIntegration),
  });
}

/**
 * GET /api/v1/projects/:projectId/security/integrations/:integrationId
 * Get integration details by ID.
 */
export async function getSecurityIntegration(req, res) {
  const { projectId, integrationId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(integrationId)) {
    return res.status(404).json({ success: false, message: 'Security integration not found' });
  }

  const integration = await SecurityIntegration.findOne({
    _id: integrationId,
    project: projectId,
  }).populate('repository', 'name fullName defaultBranch htmlUrl');

  if (!integration) {
    return res.status(404).json({ success: false, message: 'Security integration not found' });
  }

  return sendSuccess(res, {
    data: formatIntegration(integration),
  });
}

/**
 * PATCH /api/v1/projects/:projectId/security/integrations/:integrationId
 * Update integration metadata (name, isActive, repositoryId).
 */
export async function updateSecurityIntegration(req, res) {
  const { projectId, integrationId } = req.params;
  const { name, isActive, repositoryId } = req.body;

  if (!mongoose.Types.ObjectId.isValid(integrationId)) {
    return res.status(404).json({ success: false, message: 'Security integration not found' });
  }

  const integration = await SecurityIntegration.findOne({
    _id: integrationId,
    project: projectId,
  });

  if (!integration) {
    return res.status(404).json({ success: false, message: 'Security integration not found' });
  }

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Name must be between 2 and 100 characters',
      });
    }

    const dup = await SecurityIntegration.findOne({
      project: projectId,
      name: name.trim(),
      _id: { $ne: integrationId },
    });
    if (dup) {
      return res.status(409).json({
        success: false,
        message: `A security integration named '${name.trim()}' already exists in this project`,
      });
    }
    integration.name = name.trim();
  }

  if (isActive !== undefined) {
    integration.isActive = Boolean(isActive);
  }

  if (repositoryId !== undefined) {
    if (repositoryId) {
      if (!mongoose.Types.ObjectId.isValid(repositoryId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid repositoryId format',
        });
      }
      const repoExists = await Repository.findOne({ _id: repositoryId, project: projectId });
      if (!repoExists) {
        return res.status(400).json({
          success: false,
          message: 'Repository not found or does not belong to this project',
        });
      }
      integration.repository = repositoryId;
    } else {
      integration.repository = null;
    }
  }

  integration.updatedBy = req.user.id;
  await integration.save();

  await AuditService.log({
    action: 'security.integration.updated',
    actor: req.user.id,
    entityType: ENTITY_TYPES.SECURITY_INTEGRATION,
    entityId: integration._id,
    projectId,
    metadata: { updates: req.body },
  });

  return sendSuccess(res, {
    message: 'Security integration updated successfully',
    data: formatIntegration(integration),
  });
}

/**
 * POST /api/v1/projects/:projectId/security/integrations/:integrationId/rotate
 * Rotate ingestion secret, generating a new one and invalidating previous secret.
 */
export async function rotateSecurityIntegrationSecret(req, res) {
  const { projectId, integrationId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(integrationId)) {
    return res.status(404).json({ success: false, message: 'Security integration not found' });
  }

  const integration = await SecurityIntegration.findOne({
    _id: integrationId,
    project: projectId,
  });

  if (!integration) {
    return res.status(404).json({ success: false, message: 'Security integration not found' });
  }

  const newRawSecret = crypto.randomBytes(32).toString('hex');
  const enc = encrypt(newRawSecret);

  integration.encryptedIngestionSecret = enc.ciphertext;
  integration.ingestionSecretIv = enc.iv;
  integration.ingestionSecretAuthTag = enc.authTag;
  integration.ingestionSecretHint = maskToken(newRawSecret);
  integration.updatedBy = req.user.id;
  await integration.save();

  await AuditService.log({
    action: AUDIT_ACTIONS.SECURITY_INTEGRATION_ROTATED,
    actor: req.user.id,
    entityType: ENTITY_TYPES.SECURITY_INTEGRATION,
    entityId: integration._id,
    projectId,
  });

  return sendSuccess(res, {
    message: 'Ingestion secret rotated successfully',
    data: {
      _id: integration._id,
      ingestionSecretHint: integration.ingestionSecretHint,
      webhookUrl: `/api/v1/webhooks/security/${integration._id}`,
      ingestionSecret: newRawSecret, // Returned once upon rotation
    },
  });
}

/**
 * DELETE /api/v1/projects/:projectId/security/integrations/:integrationId
 * Delete a SecurityIntegration.
 */
export async function deleteSecurityIntegration(req, res) {
  const { projectId, integrationId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(integrationId)) {
    return res.status(404).json({ success: false, message: 'Security integration not found' });
  }

  const deleted = await SecurityIntegration.findOneAndDelete({
    _id: integrationId,
    project: projectId,
  });

  if (!deleted) {
    return res.status(404).json({ success: false, message: 'Security integration not found' });
  }

  await AuditService.log({
    action: AUDIT_ACTIONS.SECURITY_INTEGRATION_DELETED,
    actor: req.user.id,
    entityType: ENTITY_TYPES.SECURITY_INTEGRATION,
    entityId: integrationId,
    projectId,
    metadata: { name: deleted.name },
  });

  return sendSuccess(res, {
    message: 'Security integration deleted successfully',
  });
}

/**
 * POST /api/v1/webhooks/security/:integrationId
 * Public CI Ingestion Webhook for external scanners (Trivy).
 * Authenticated via X-Security-Token header using constant-time comparison.
 * Binds project authoritatively from integration (payload.projectId is never trusted).
 */
export async function handleSecurityWebhook(req, res) {
  const { integrationId } = req.params;

  // 1. Validate integrationId format
  if (!integrationId || !mongoose.Types.ObjectId.isValid(integrationId)) {
    // Constant-time padding to prevent timing analysis
    crypto.timingSafeEqual(Buffer.from('dummy_token_padding'), Buffer.from('dummy_token_padding'));
    return res.status(401).json({
      success: false,
      message: 'Invalid or missing security token',
    });
  }

  // 2. Fetch active SecurityIntegration
  const integration = await SecurityIntegration.findOne({
    _id: integrationId,
    isActive: true,
  }).select('+encryptedIngestionSecret +ingestionSecretIv +ingestionSecretAuthTag');

  if (!integration) {
    crypto.timingSafeEqual(Buffer.from('dummy_token_padding'), Buffer.from('dummy_token_padding'));
    return res.status(401).json({
      success: false,
      message: 'Invalid or missing security token',
    });
  }

  // 3. Decrypt and verify X-Security-Token using constant-time comparison
  const providedToken = req.headers['x-security-token'];
  if (!providedToken) {
    crypto.timingSafeEqual(Buffer.from('dummy_token_padding'), Buffer.from('dummy_token_padding'));
    return res.status(401).json({
      success: false,
      message: 'Invalid or missing security token',
    });
  }

  const expectedSecret = decrypt({
    ciphertext: integration.encryptedIngestionSecret,
    iv: integration.ingestionSecretIv,
    authTag: integration.ingestionSecretAuthTag,
  });

  const isValidToken = verifySecurityToken(providedToken, expectedSecret);
  if (!isValidToken) {
    await AuditService.log({
      action: AUDIT_ACTIONS.SECURITY_SCAN_FAILED,
      entityType: ENTITY_TYPES.SECURITY_INTEGRATION,
      entityId: integration._id,
      projectId: integration.project,
      metadata: { reason: 'Authentication failed' },
    });
    return res.status(401).json({
      success: false,
      message: 'Invalid or missing security token',
    });
  }

  // 4. Validate payload format
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({
      success: false,
      message: 'Malformed report payload: expected JSON object',
    });
  }

  // 5. Validate provider
  if (!hasSecurityProvider(integration.provider)) {
    return res.status(400).json({
      success: false,
      message: `Unsupported security provider: ${integration.provider}`,
    });
  }

  // 6. Minimum report structure validation
  const rawReport = req.body.report || req.body;
  if (integration.provider === 'trivy') {
    if (rawReport.SchemaVersion === undefined || !Array.isArray(rawReport.Results)) {
      return res.status(400).json({
        success: false,
        message: 'Malformed Trivy report: missing SchemaVersion or Results array',
      });
    }
  }

  // 7. Authoritative project binding (NEVER trust req.body.projectId)
  const projectId = integration.project;

  // 8. Traceability reference validation
  let validatedRepositoryId = req.body.repositoryId || integration.repository || null;
  if (req.body.repositoryId) {
    if (!mongoose.Types.ObjectId.isValid(req.body.repositoryId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid repositoryId format',
      });
    }
    const repoExists = await Repository.findOne({
      _id: req.body.repositoryId,
      project: projectId,
    });
    if (!repoExists) {
      return res.status(400).json({
        success: false,
        message: 'Invalid repositoryId: repository does not belong to this project',
      });
    }
    validatedRepositoryId = req.body.repositoryId;
  }

  let validatedPipelineRunId = null;
  if (req.body.pipelineRunId) {
    if (!mongoose.Types.ObjectId.isValid(req.body.pipelineRunId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pipelineRunId format',
      });
    }
    const runExists = await PipelineRun.findOne({
      _id: req.body.pipelineRunId,
      project: projectId,
    });
    if (!runExists) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pipelineRunId: pipeline run does not belong to this project',
      });
    }
    validatedPipelineRunId = req.body.pipelineRunId;
  }

  // 9. Compute deterministic SHA-256 reportDigest from raw request
  const digestInput = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const reportDigest = crypto.createHash('sha256').update(digestInput).digest('hex');

  // 10. Atomic idempotency claim
  const claim = await SecurityDelivery.claimDelivery({
    integrationId: integration._id,
    projectId,
    reportDigest,
  });

  if (!claim.claimed) {
    logger.info(
      `Duplicate security scan delivery ignored (integration: ${integration._id}, digest: ${reportDigest.substring(0, 12)}...)`
    );
    return res.status(202).json({
      success: true,
      message: 'Duplicate security report already claimed',
      data: {
        deliveryId: claim.delivery?._id,
        reportDigest,
        status: claim.delivery?.status || 'already_received',
        duplicate: true,
      },
    });
  }

  // 11. Enqueue BullMQ ingestion job
  const commitSha = req.body.commitSha || '';
  const branch = req.body.branch || '';
  const target = req.body.target || rawReport.ArtifactName || '';
  const scanType =
    req.body.scanType || (rawReport.ArtifactType === 'container_image' ? 'image' : 'filesystem');

  const enqueueResult = await enqueueSecurityScanJob({
    securityIntegrationId: String(integration._id),
    projectId: String(projectId),
    repositoryId: validatedRepositoryId,
    pipelineRunId: validatedPipelineRunId,
    commitSha,
    branch,
    target,
    scanType,
    provider: integration.provider,
    reportDigest,
    rawPayload: req.body,
  });

  // 12. Update delivery tracking & integration lastUsedAt
  if (claim.delivery && enqueueResult?.jobId) {
    await SecurityDelivery.findByIdAndUpdate(claim.delivery._id, {
      status: 'queued',
      jobId: String(enqueueResult.jobId),
    });
  }

  await SecurityIntegration.findByIdAndUpdate(integration._id, {
    lastUsedAt: new Date(),
  });

  await AuditService.log({
    action: AUDIT_ACTIONS.SECURITY_SCAN_INGESTED,
    entityType: ENTITY_TYPES.SECURITY_SCAN,
    projectId,
    metadata: {
      integrationId: integration._id,
      provider: integration.provider,
      reportDigest,
      target,
    },
  });

  return res.status(202).json({
    success: true,
    message: 'Security report accepted for asynchronous processing',
    data: {
      deliveryId: claim.delivery._id,
      reportDigest,
      status: 'queued',
      duplicate: false,
    },
  });
}

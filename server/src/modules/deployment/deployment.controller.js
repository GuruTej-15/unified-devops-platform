import DeploymentService from './deployment.service.js';
import { sendCreated, sendSuccess, sendPaginated } from '../../shared/apiResponse.js';
import { NotFoundError, BadRequestError } from '../../shared/errors.js';
import { DEPLOYMENT_PROVIDER_VALUES, DEPLOYMENT_STATUS_VALUES } from '../../shared/constants.js';

export const ingestDeployment = async (req, res) => {
  const { externalDeploymentId, provider, status } = req.body || {};
  if (!externalDeploymentId) {
    throw new BadRequestError('externalDeploymentId is required');
  }
  if (!provider) {
    throw new BadRequestError('provider is required');
  }
  if (!DEPLOYMENT_PROVIDER_VALUES.includes(provider)) {
    throw new BadRequestError(
      `Invalid provider: ${provider}. Allowed providers: ${DEPLOYMENT_PROVIDER_VALUES.join(', ')}`
    );
  }
  if (status && !DEPLOYMENT_STATUS_VALUES.includes(status)) {
    throw new BadRequestError(
      `Invalid status: ${status}. Allowed status: ${DEPLOYMENT_STATUS_VALUES.join(', ')}`
    );
  }

  const deployment = await DeploymentService.recordDeployment(req.params.projectId, req.body);

  sendCreated(res, {
    data: deployment,
    message: 'Deployment recorded successfully',
  });
};

export const listDeployments = async (req, res) => {
  const { data, total, page, limit } = await DeploymentService.listDeployments(
    req.params.projectId,
    req.query
  );
  sendPaginated(res, { data, page, limit, total });
};

export const getDeployment = async (req, res) => {
  const deployment = await DeploymentService.getDeploymentById(
    req.params.projectId,
    req.params.deploymentId
  );
  if (!deployment) {
    throw new NotFoundError('Deployment not found');
  }
  sendSuccess(res, { data: deployment });
};

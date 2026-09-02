import AuditService from './audit.service.js';
import { sendPaginated } from '../../shared/apiResponse.js';

export const listAuditLogs = async (req, res) => {
  const { data, total, page, limit } = await AuditService.listAuditLogs({
    page: parseInt(req.query.page, 10) || 1,
    limit: parseInt(req.query.limit, 10) || 20,
    action: req.query.action,
    entityType: req.query.entityType,
    actor: req.query.actor,
  });
  sendPaginated(res, { data, page, limit, total });
};

export const listProjectAuditLogs = async (req, res) => {
  const { data, total, page, limit } = await AuditService.listProjectAuditLogs(
    req.params.projectId,
    {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 20,
    }
  );
  sendPaginated(res, { data, page, limit, total });
};

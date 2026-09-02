/**
 * Standardized API response helpers.
 *
 * Success: { success: true, data, message, pagination? }
 * Error:   { success: false, message, errors? }
 */

export const sendSuccess = (
  res,
  { data = null, message = 'Success', statusCode = 200, pagination = null } = {}
) => {
  const response = { success: true, message, data };
  if (pagination) {
    response.pagination = pagination;
  }
  return res.status(statusCode).json(response);
};

export const sendCreated = (res, { data = null, message = 'Created successfully' } = {}) => {
  return sendSuccess(res, { data, message, statusCode: 201 });
};

export const sendError = (
  res,
  { message = 'Internal server error', statusCode = 500, errors = null } = {}
) => {
  const response = { success: false, message };
  if (errors) {
    response.errors = errors;
  }
  return res.status(statusCode).json(response);
};

export const sendPaginated = (res, { data, page, limit, total, message = 'Success' }) => {
  return sendSuccess(res, {
    data,
    message,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
};

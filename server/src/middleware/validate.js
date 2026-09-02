import { ValidationError } from '../shared/errors.js';

/**
 * Zod validation middleware factory.
 * Validates req.body (and optionally req.query, req.params) against a Zod schema.
 *
 * @param {import('zod').ZodSchema} schema - Zod schema to validate against
 * @param {'body'|'query'|'params'} source - Which part of the request to validate
 */
const validate = (schema, source = 'body') => {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      throw new ValidationError(errors);
    }

    // Replace with parsed (coerced/transformed) data
    req[source] = result.data;
    next();
  };
};

export default validate;

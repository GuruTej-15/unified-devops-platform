import { z } from 'zod';
import {
  ISSUE_STATUS_VALUES,
  ISSUE_PRIORITY_VALUES,
  ISSUE_TYPE_VALUES,
} from '../../shared/constants.js';

export const createIssueSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(50000).optional(),
  status: z.enum(ISSUE_STATUS_VALUES).optional(),
  priority: z.enum(ISSUE_PRIORITY_VALUES).optional(),
  type: z.enum(ISSUE_TYPE_VALUES).optional(),
  assignee: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId')
    .optional(),
  labels: z.array(z.string()).optional(),
});

export const updateIssueSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(50000).optional(),
  status: z.enum(ISSUE_STATUS_VALUES).optional(),
  priority: z.enum(ISSUE_PRIORITY_VALUES).optional(),
  type: z.enum(ISSUE_TYPE_VALUES).optional(),
  assignee: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId')
    .nullable()
    .optional(),
  labels: z.array(z.string()).optional(),
});

export const createCommentSchema = z.object({
  body: z.string().min(1).max(10000),
});

export const listIssuesQuery = z.object({
  status: z.enum(ISSUE_STATUS_VALUES).optional(),
  priority: z.enum(ISSUE_PRIORITY_VALUES).optional(),
  type: z.enum(ISSUE_TYPE_VALUES).optional(),
  assignee: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'priority', 'status']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

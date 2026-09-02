import { z } from 'zod';
import { PROJECT_MEMBER_ROLE_VALUES } from '../../shared/constants.js';
import mongoose from 'mongoose';

const objectIdSchema = z.string().refine((val) => mongoose.Types.ObjectId.isValid(val), {
  message: 'Invalid ObjectId',
});

export const createProjectSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  key: z
    .string()
    .min(2)
    .max(5)
    .regex(/^[a-zA-Z]{2,5}$/, 'Must be 2-5 letters')
    .transform((val) => val.toUpperCase()),
  description: z.string().max(2000).optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  description: z.string().max(2000).optional(),
});

export const addMemberSchema = z.object({
  userId: objectIdSchema,
  role: z.enum(PROJECT_MEMBER_ROLE_VALUES).default('developer'),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(PROJECT_MEMBER_ROLE_VALUES),
});

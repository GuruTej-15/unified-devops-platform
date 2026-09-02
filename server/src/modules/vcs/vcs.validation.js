import { z } from 'zod';

export const connectRepoSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required').trim(),
  name: z.string().min(1, 'Repository name is required').trim(),
  token: z.string().min(1, 'GitHub token is required'),
});

export const syncRepoSchema = z.object({});

import { z } from 'zod';
import { paginationSchema } from '../../lib/http.js';

export const listUsersQuery = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  roleId: z.string().optional(),
  status: z.enum(['all', 'active', 'inactive']).default('active'),
  projectId: z.string().optional(),
  sort: z.enum(['name', 'createdAt', 'lastLoginAt']).default('name'),
});

export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  name: z.string().trim().min(2).max(120).optional(),
  roleId: z.string().min(1, 'Choose a workspace role'),
  projectGrants: z
    .array(z.object({ projectId: z.string().min(1), roleId: z.string().min(1) }))
    .max(50)
    .optional(),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  jobTitle: z.string().max(120).trim().nullish(),
  responsibilities: z.string().max(2000).trim().nullish(),
  timezone: z.string().max(64).optional(),
  globalRoleId: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

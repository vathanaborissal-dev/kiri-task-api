import { z } from 'zod';
import { WILDCARD, isValidPermission } from '../../config/permissions.js';

const permissionList = z
  .array(z.string())
  .max(200)
  .refine((keys) => keys.every(isValidPermission), {
    message: 'One or more permissions are not recognised',
  })
  .transform((keys) => [...new Set(keys)]);

export const createRoleSchema = z.object({
  name: z.string().trim().min(2, 'Give the role a name').max(60),
  description: z.string().max(400).trim().nullish(),
  scope: z.enum(['GLOBAL', 'PROJECT']),
  permissions: permissionList.default([]),
});

export const updateRoleSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().max(400).trim().nullish(),
  permissions: permissionList.optional(),
  isDefault: z.boolean().optional(),
});

export const listRolesQuery = z.object({
  scope: z.enum(['GLOBAL', 'PROJECT']).optional(),
});

export const WILDCARD_PERMISSION = WILDCARD;

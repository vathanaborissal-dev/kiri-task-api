import { z } from 'zod';
import { csvArray, optionalDate, paginationSchema } from '../../lib/http.js';

export const RELEASE_STATUSES = [
  'PLANNED',
  'IN_DEVELOPMENT',
  'READY',
  'RELEASED',
  'CANCELED',
] as const;

export const DEPLOYMENT_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'SUCCEEDED',
  'FAILED',
  'ROLLED_BACK',
] as const;

export const listReleasesQuery = paginationSchema.extend({
  projectId: z.string().optional(),
  status: csvArray,
  phaseId: csvArray,
  isHotfix: z.coerce.boolean().optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(['createdAt', 'plannedDate', 'releasedAt', 'version']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const createReleaseSchema = z.object({
  projectId: z.string().min(1, 'Choose a project'),
  version: z
    .string()
    .min(1, 'Give the release a version')
    .max(40)
    .regex(/^[A-Za-z0-9._+-]+$/, 'Use letters, numbers, dots and dashes'),
  name: z.string().max(120).trim().nullish(),
  description: z.string().max(5000).nullish(),
  releaseNotes: z.string().max(20000).nullish(),
  status: z.enum(RELEASE_STATUSES).optional(),
  isHotfix: z.boolean().optional(),
  plannedDate: optionalDate,
  taskIds: z.array(z.string().min(1)).max(200).optional(),
  issueIds: z.array(z.string().min(1)).max(200).optional(),
});

export const updateReleaseSchema = z.object({
  version: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9._+-]+$/)
    .optional(),
  name: z.string().max(120).trim().nullish(),
  description: z.string().max(5000).nullish(),
  releaseNotes: z.string().max(20000).nullish(),
  status: z.enum(RELEASE_STATUSES).optional(),
  isHotfix: z.boolean().optional(),
  plannedDate: optionalDate,
  releasedAt: optionalDate,
});

export const deploymentSchema = z.object({
  phaseId: z.string().min(1, 'Choose the phase you deployed to'),
  status: z.enum(DEPLOYMENT_STATUSES).optional(),
  notes: z.string().max(5000).trim().nullish(),
  deployedAt: optionalDate,
});

export const releaseScopeSchema = z.object({
  taskIds: z.array(z.string().min(1)).max(200).optional(),
  issueIds: z.array(z.string().min(1)).max(200).optional(),
  /** `set` replaces the scope; `add` and `remove` adjust it. */
  mode: z.enum(['add', 'remove', 'set']).default('add'),
});

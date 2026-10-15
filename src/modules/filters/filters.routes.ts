import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './filters.controller.js';

export const filtersRouter = Router();

filtersRouter.use(requireAuth);

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the filter a name').max(60),
  scope: z.enum(['TASK', 'ISSUE']),
  query: z.record(z.string(), z.unknown()),
  projectId: z.string().nullish(),
  isShared: z.boolean().optional(),
});

filtersRouter.get('/', asyncHandler(controller.listFilters));
filtersRouter.post('/', validate({ body: createSchema }), asyncHandler(controller.createFilter));
filtersRouter.patch(
  '/:filterId',
  validate({ body: createSchema.partial() }),
  asyncHandler(controller.updateFilter),
);
filtersRouter.delete('/:filterId', asyncHandler(controller.deleteFilter));

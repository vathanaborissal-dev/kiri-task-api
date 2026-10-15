import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { queryBoolean } from '../../lib/http.js';
import * as controller from './dashboard.controller.js';

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get('/overview', asyncHandler(controller.getOverview));
dashboardRouter.get('/my-work', asyncHandler(controller.getMyWork));
dashboardRouter.get(
  '/portfolio',
  validate({
    query: z.object({
      weeks: z.coerce.number().int().min(4).max(52).default(12),
      includeArchived: queryBoolean.default(false),
    }),
  }),
  asyncHandler(controller.getPortfolio),
);
dashboardRouter.get('/projects/:projectId', asyncHandler(controller.getProjectReport));

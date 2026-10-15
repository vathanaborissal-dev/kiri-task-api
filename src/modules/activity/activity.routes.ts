import { Router } from 'express';
import { z } from 'zod';
import { paginationSchema } from '../../lib/http.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './activity.controller.js';

export const activityRouter = Router();

activityRouter.use(requireAuth);

const query = paginationSchema.extend({
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  issueId: z.string().optional(),
  hotfixId: z.string().optional(),
  releaseId: z.string().optional(),
  actorId: z.string().optional(),
  entityType: z.string().optional(),
  action: z.string().optional(),
});

activityRouter.get('/', validate({ query }), asyncHandler(controller.listActivity));
activityRouter.get(
  '/audit',
  requirePermission('audit:view'),
  validate({ query }),
  asyncHandler(controller.listAudit),
);

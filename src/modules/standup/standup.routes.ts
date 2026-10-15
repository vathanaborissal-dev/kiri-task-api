import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './standup.controller.js';

export const standupRouter = Router();

standupRouter.use(requireAuth);

const dayKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form')
  .optional();

const kind = z.enum(['FOCUS', 'BLOCKER']);

const noteSchema = z.object({
  date: dayKey,
  note: z.string().max(2000).nullish(),
});

const itemSchema = z.object({
  date: dayKey,
  kind: kind.optional(),
  body: z.string().trim().min(1, 'Write something first').max(500),
  taskId: z.string().nullish(),
});

const patchSchema = z
  .object({
    body: z.string().trim().min(1).max(500),
    kind,
    isDone: z.boolean(),
    resolved: z.boolean(),
  })
  .partial();

const reorderSchema = z.object({ itemIds: z.array(z.string()).min(1).max(100) });

// Your own day.
standupRouter.get('/me', asyncHandler(controller.getMyPlan));
standupRouter.put('/me', validate({ body: noteSchema }), asyncHandler(controller.updateMyPlan));
standupRouter.post('/me/items', validate({ body: itemSchema }), asyncHandler(controller.addItem));
standupRouter.post(
  '/me/items/reorder',
  validate({ body: reorderSchema }),
  asyncHandler(controller.reorderItems),
);
standupRouter.patch(
  '/items/:itemId',
  validate({ body: patchSchema }),
  asyncHandler(controller.updateItem),
);
standupRouter.delete('/items/:itemId', asyncHandler(controller.deleteItem));

// Everyone you are allowed to see. The handler decides who that is.
standupRouter.get('/team', asyncHandler(controller.teamPlans));

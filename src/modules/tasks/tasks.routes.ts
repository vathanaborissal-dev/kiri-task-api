import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './tasks.controller.js';
import * as schemas from './tasks.schemas.js';

export const tasksRouter = Router();

tasksRouter.use(requireAuth);

tasksRouter.get(
  '/',
  validate({ query: schemas.listTasksQuery }),
  asyncHandler(controller.listTasks),
);
tasksRouter.get(
  '/board',
  validate({ query: schemas.listTasksQuery }),
  asyncHandler(controller.getBoard),
);
tasksRouter.get('/schedule', asyncHandler(controller.getSchedule));

tasksRouter.post(
  '/',
  writeLimiter,
  validate({ body: schemas.createTaskSchema }),
  asyncHandler(controller.createTask),
);
tasksRouter.post(
  '/bulk',
  writeLimiter,
  validate({ body: schemas.bulkUpdateSchema }),
  asyncHandler(controller.bulkUpdate),
);

tasksRouter.get('/:taskId', asyncHandler(controller.getTask));
tasksRouter.patch(
  '/:taskId',
  validate({ body: schemas.updateTaskSchema }),
  asyncHandler(controller.updateTask),
);
tasksRouter.post(
  '/:taskId/move',
  validate({ body: schemas.moveTaskSchema }),
  asyncHandler(controller.moveTask),
);
tasksRouter.delete('/:taskId', asyncHandler(controller.deleteTask));
tasksRouter.post('/:taskId/watch', asyncHandler(controller.toggleWatch));

tasksRouter.post(
  '/:taskId/checklist',
  validate({ body: schemas.checklistItemSchema }),
  asyncHandler(controller.addChecklistItem),
);
tasksRouter.patch(
  '/:taskId/checklist/:itemId',
  validate({ body: schemas.updateChecklistItemSchema }),
  asyncHandler(controller.updateChecklistItem),
);
tasksRouter.delete('/:taskId/checklist/:itemId', asyncHandler(controller.deleteChecklistItem));

tasksRouter.post(
  '/:taskId/links',
  validate({ body: schemas.linkSchema }),
  asyncHandler(controller.addLink),
);
tasksRouter.delete('/:taskId/links/:linkId', asyncHandler(controller.deleteLink));

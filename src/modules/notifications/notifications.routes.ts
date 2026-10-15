import { Router } from 'express';
import { z } from 'zod';
import { paginationSchema, queryBoolean } from '../../lib/http.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { NotificationEvent } from '../../generated/prisma/enums.js';
import * as controller from './notifications.controller.js';

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

const eventEnum = z.enum(
  Object.values(NotificationEvent) as [string, ...string[]],
);

notificationsRouter.get(
  '/',
  validate({ query: paginationSchema.extend({ unreadOnly: queryBoolean.default(false) }) }),
  asyncHandler(controller.listNotifications),
);
notificationsRouter.get('/stream', controller.stream);
notificationsRouter.get('/preferences', asyncHandler(controller.getPreferences));
notificationsRouter.put(
  '/preferences',
  validate({
    body: z.object({
      settings: z
        .array(
          z.object({
            event: eventEnum,
            web: z.boolean().optional(),
            telegram: z.boolean().optional(),
            email: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(50),
    }),
  }),
  asyncHandler(controller.updatePreferences),
);
notificationsRouter.post(
  '/read',
  validate({
    body: z.object({
      ids: z.array(z.string().min(1)).max(200).optional(),
      all: z.boolean().optional(),
    }),
  }),
  asyncHandler(controller.markRead),
);
notificationsRouter.post('/:notificationId/unread', asyncHandler(controller.markUnread));
notificationsRouter.delete('/read', asyncHandler(controller.clearRead));

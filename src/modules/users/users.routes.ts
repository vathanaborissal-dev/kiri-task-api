import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './users.controller.js';
import * as schemas from './users.schemas.js';

export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get(
  '/',
  requirePermission('user:view'),
  validate({ query: schemas.listUsersQuery }),
  asyncHandler(controller.listUsers),
);
usersRouter.get('/workload', requirePermission('report:view'), asyncHandler(controller.getWorkload));
usersRouter.get(
  '/invitations',
  requirePermission('user:invite'),
  asyncHandler(controller.listInvitations),
);
usersRouter.post(
  '/invitations',
  requirePermission('user:invite'),
  validate({ body: schemas.inviteUserSchema }),
  asyncHandler(controller.inviteUser),
);
usersRouter.delete(
  '/invitations/:invitationId',
  requirePermission('user:invite'),
  asyncHandler(controller.revokeInvitation),
);

usersRouter.get('/:userId', asyncHandler(controller.getUser));
usersRouter.patch(
  '/:userId',
  validate({ body: schemas.updateUserSchema }),
  asyncHandler(controller.updateUser),
);
usersRouter.delete('/:userId', requirePermission('user:delete'), asyncHandler(controller.deleteUser));

import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './roles.controller.js';
import * as schemas from './roles.schemas.js';

export const rolesRouter = Router();

rolesRouter.use(requireAuth);

rolesRouter.get('/permissions', requirePermission('role:view'), controller.getCatalogue);
rolesRouter.get(
  '/',
  requirePermission('role:view'),
  validate({ query: schemas.listRolesQuery }),
  asyncHandler(controller.listRoles),
);
rolesRouter.get('/:roleId', requirePermission('role:view'), asyncHandler(controller.getRole));
rolesRouter.post(
  '/',
  requirePermission('role:create'),
  validate({ body: schemas.createRoleSchema }),
  asyncHandler(controller.createRole),
);
rolesRouter.patch(
  '/:roleId',
  requirePermission('role:update'),
  validate({ body: schemas.updateRoleSchema }),
  asyncHandler(controller.updateRole),
);
rolesRouter.delete('/:roleId', requirePermission('role:delete'), asyncHandler(controller.deleteRole));

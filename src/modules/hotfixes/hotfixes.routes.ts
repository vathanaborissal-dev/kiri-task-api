import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './hotfixes.controller.js';
import * as schemas from './hotfixes.schemas.js';

export const hotfixesRouter = Router();

hotfixesRouter.use(requireAuth);

hotfixesRouter.get(
  '/',
  validate({ query: schemas.listHotfixesQuery }),
  asyncHandler(controller.listHotfixes),
);
hotfixesRouter.post(
  '/',
  validate({ body: schemas.createHotfixSchema }),
  asyncHandler(controller.createHotfix),
);
hotfixesRouter.get('/:hotfixId', asyncHandler(controller.getHotfix));
hotfixesRouter.patch(
  '/:hotfixId',
  validate({ body: schemas.updateHotfixSchema }),
  asyncHandler(controller.updateHotfix),
);
hotfixesRouter.post(
  '/:hotfixId/decision',
  validate({ body: schemas.decisionSchema }),
  asyncHandler(controller.decide),
);
hotfixesRouter.delete('/:hotfixId', asyncHandler(controller.deleteHotfix));

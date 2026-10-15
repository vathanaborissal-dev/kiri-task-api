import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './releases.controller.js';
import * as schemas from './releases.schemas.js';

export const releasesRouter = Router();

releasesRouter.use(requireAuth);

releasesRouter.get(
  '/',
  validate({ query: schemas.listReleasesQuery }),
  asyncHandler(controller.listReleases),
);
releasesRouter.get('/phase-board', asyncHandler(controller.getPhaseBoard));
releasesRouter.post(
  '/',
  validate({ body: schemas.createReleaseSchema }),
  asyncHandler(controller.createRelease),
);
releasesRouter.get('/:releaseId', asyncHandler(controller.getRelease));
releasesRouter.patch(
  '/:releaseId',
  validate({ body: schemas.updateReleaseSchema }),
  asyncHandler(controller.updateRelease),
);
releasesRouter.delete('/:releaseId', asyncHandler(controller.deleteRelease));
releasesRouter.post(
  '/:releaseId/scope',
  validate({ body: schemas.releaseScopeSchema }),
  asyncHandler(controller.updateScope),
);
releasesRouter.post(
  '/:releaseId/deployments',
  validate({ body: schemas.deploymentSchema }),
  asyncHandler(controller.recordDeployment),
);
releasesRouter.delete(
  '/:releaseId/deployments/:deploymentId',
  asyncHandler(controller.deleteDeployment),
);

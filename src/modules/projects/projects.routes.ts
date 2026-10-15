import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import * as settings from './projectSettings.controller.js';
import * as controller from './projects.controller.js';
import * as schemas from './projects.schemas.js';

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

projectsRouter.get(
  '/',
  validate({ query: schemas.listProjectsQuery }),
  asyncHandler(controller.listProjects),
);
projectsRouter.post(
  '/',
  requirePermission('project:create'),
  writeLimiter,
  validate({ body: schemas.createProjectSchema }),
  asyncHandler(controller.createProject),
);

projectsRouter.get('/:projectId', asyncHandler(controller.getProject));
projectsRouter.patch(
  '/:projectId',
  validate({ body: schemas.updateProjectSchema }),
  asyncHandler(controller.updateProject),
);
projectsRouter.post('/:projectId/archive', asyncHandler(controller.archiveProject));
projectsRouter.delete('/:projectId', asyncHandler(controller.deleteProject));

// --- Members ---------------------------------------------------------------
projectsRouter.get('/:projectId/members', asyncHandler(controller.listMembers));
projectsRouter.get('/:projectId/assignable-users', asyncHandler(controller.listAssignableUsers));
projectsRouter.post(
  '/:projectId/members',
  validate({ body: schemas.addMemberSchema }),
  asyncHandler(controller.addMember),
);
projectsRouter.patch(
  '/:projectId/members/:memberId',
  validate({ body: schemas.updateMemberSchema }),
  asyncHandler(controller.updateMember),
);
projectsRouter.delete('/:projectId/members/:memberId', asyncHandler(controller.removeMember));

// --- Statuses --------------------------------------------------------------
projectsRouter.post(
  '/:projectId/statuses',
  validate({ body: schemas.statusSchema }),
  asyncHandler(settings.createStatus),
);
projectsRouter.post(
  '/:projectId/statuses/reorder',
  validate({ body: schemas.reorderSchema }),
  asyncHandler(settings.reorderStatuses),
);
projectsRouter.patch(
  '/:projectId/statuses/:statusId',
  validate({ body: schemas.updateStatusSchema }),
  asyncHandler(settings.updateStatus),
);
projectsRouter.delete('/:projectId/statuses/:statusId', asyncHandler(settings.deleteStatus));

// --- Phases ----------------------------------------------------------------
projectsRouter.post(
  '/:projectId/phases',
  validate({ body: schemas.phaseSchema }),
  asyncHandler(settings.createPhase),
);
projectsRouter.post(
  '/:projectId/phases/reorder',
  validate({ body: schemas.reorderSchema }),
  asyncHandler(settings.reorderPhases),
);
projectsRouter.patch(
  '/:projectId/phases/:phaseId',
  validate({ body: schemas.updatePhaseSchema }),
  asyncHandler(settings.updatePhase),
);
projectsRouter.delete('/:projectId/phases/:phaseId', asyncHandler(settings.deletePhase));

// --- Labels ----------------------------------------------------------------
projectsRouter.post(
  '/:projectId/labels',
  validate({ body: schemas.labelSchema }),
  asyncHandler(settings.createLabel),
);
projectsRouter.patch(
  '/:projectId/labels/:labelId',
  validate({ body: schemas.labelSchema.partial() }),
  asyncHandler(settings.updateLabel),
);
projectsRouter.delete('/:projectId/labels/:labelId', asyncHandler(settings.deleteLabel));

// --- Milestones ------------------------------------------------------------
projectsRouter.get('/:projectId/milestones', asyncHandler(settings.listMilestones));
projectsRouter.post(
  '/:projectId/milestones',
  validate({ body: schemas.milestoneSchema }),
  asyncHandler(settings.createMilestone),
);
projectsRouter.patch(
  '/:projectId/milestones/:milestoneId',
  validate({ body: schemas.updateMilestoneSchema }),
  asyncHandler(settings.updateMilestone),
);
projectsRouter.delete(
  '/:projectId/milestones/:milestoneId',
  asyncHandler(settings.deleteMilestone),
);

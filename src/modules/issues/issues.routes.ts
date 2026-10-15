import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './issues.controller.js';
import * as schemas from './issues.schemas.js';

export const issuesRouter = Router();

issuesRouter.use(requireAuth);

issuesRouter.get(
  '/',
  validate({ query: schemas.listIssuesQuery }),
  asyncHandler(controller.listIssues),
);
issuesRouter.post(
  '/',
  writeLimiter,
  validate({ body: schemas.createIssueSchema }),
  asyncHandler(controller.createIssue),
);
issuesRouter.get('/:issueId', asyncHandler(controller.getIssue));
issuesRouter.patch(
  '/:issueId',
  validate({ body: schemas.updateIssueSchema }),
  asyncHandler(controller.updateIssue),
);
issuesRouter.post(
  '/:issueId/status',
  validate({ body: schemas.changeStatusSchema }),
  asyncHandler(controller.changeStatus),
);
issuesRouter.post('/:issueId/watch', asyncHandler(controller.toggleWatch));
issuesRouter.post('/:issueId/create-task', asyncHandler(controller.convertToTask));
issuesRouter.delete('/:issueId', asyncHandler(controller.deleteIssue));

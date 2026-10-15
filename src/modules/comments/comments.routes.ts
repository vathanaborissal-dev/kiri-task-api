import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './comments.controller.js';
import * as schemas from './comments.schemas.js';

export const commentsRouter = Router();

commentsRouter.use(requireAuth);

commentsRouter.get(
  '/',
  validate({ query: schemas.listCommentsQuery }),
  asyncHandler(controller.listComments),
);
commentsRouter.get('/mentionables', asyncHandler(controller.listMentionables));
commentsRouter.post(
  '/',
  validate({ body: schemas.createCommentSchema }),
  asyncHandler(controller.createComment),
);
commentsRouter.patch(
  '/:commentId',
  validate({ body: schemas.updateCommentSchema }),
  asyncHandler(controller.updateComment),
);
commentsRouter.delete('/:commentId', asyncHandler(controller.deleteComment));

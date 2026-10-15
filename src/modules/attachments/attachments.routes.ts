import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { uploadLimiter } from '../../middleware/rateLimit.js';
import * as controller from './attachments.controller.js';

export const attachmentsRouter = Router();

attachmentsRouter.use(requireAuth);

attachmentsRouter.get('/', asyncHandler(controller.listAttachments));
attachmentsRouter.post(
  '/',
  uploadLimiter,
  controller.upload.array('files', 10),
  asyncHandler(controller.uploadAttachments),
);
attachmentsRouter.delete('/:attachmentId', asyncHandler(controller.deleteAttachment));

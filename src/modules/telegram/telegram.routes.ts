import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import * as controller from './telegram.controller.js';

export const telegramRouter = Router();

telegramRouter.use(requireAuth);

telegramRouter.get('/status', asyncHandler(controller.getStatus));
telegramRouter.post('/link-code', writeLimiter, asyncHandler(controller.createLinkCode));
telegramRouter.delete('/link', asyncHandler(controller.unlink));
telegramRouter.post('/test', writeLimiter, asyncHandler(controller.sendTest));

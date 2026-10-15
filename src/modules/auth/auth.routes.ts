import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { csrfProtection } from '../../middleware/csrf.js';
import { authIpLimiter, authLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './auth.controller.js';
import * as schemas from './auth.schemas.js';

export const authRouter = Router();

authRouter.post(
  '/login',
  authIpLimiter,
  authLimiter,
  validate({ body: schemas.loginSchema }),
  asyncHandler(controller.postLogin),
);

/**
 * Deliberately *not* behind the CSRF check.
 *
 * Refresh is the one place a stolen refresh token gets replayed, and replaying
 * a rotated token is what trips the reuse detection that revokes the whole
 * family. A CSRF check here rejects that replay with a 403 before the tripwire
 * fires — and it buys nothing against the attacker it matters for, since
 * double-submit only defends against a victim's browser being driven
 * cross-site, not against someone running their own client who can set both
 * halves. SameSite=Lax already blocks the cross-site case, whose worst outcome
 * is a forced rotation the victim does not even notice.
 */
authRouter.post('/refresh', asyncHandler(controller.postRefresh));

// Logout has no such tripwire to lose, and forced-logout CSRF is a real (if
// minor) nuisance, so this one does take the check.
authRouter.post('/logout', csrfProtection, asyncHandler(controller.postLogout));

authRouter.post(
  '/forgot-password',
  authLimiter,
  validate({ body: schemas.forgotPasswordSchema }),
  asyncHandler(controller.postForgotPassword),
);
authRouter.post(
  '/reset-password',
  authLimiter,
  validate({ body: schemas.resetPasswordSchema }),
  asyncHandler(controller.postResetPassword),
);

authRouter.get('/invitation', asyncHandler(controller.getInvitation));
authRouter.post(
  '/invitation/accept',
  authLimiter,
  validate({ body: schemas.acceptInvitationSchema }),
  asyncHandler(controller.postAcceptInvitation),
);

authRouter.use(requireAuth, csrfProtection);

authRouter.get('/me', asyncHandler(controller.getMe));
authRouter.patch(
  '/me',
  validate({ body: schemas.updateProfileSchema }),
  asyncHandler(controller.patchProfile),
);
authRouter.post(
  '/me/seen',
  validate({
    body: z.object({ changelog: z.boolean().optional(), guide: z.boolean().optional() }),
  }),
  asyncHandler(controller.markSeen),
);
authRouter.post(
  '/change-password',
  validate({ body: schemas.changePasswordSchema }),
  asyncHandler(controller.postChangePassword),
);
authRouter.get('/sessions', asyncHandler(controller.getSessions));
authRouter.delete('/sessions', asyncHandler(controller.deleteAllSessions));
authRouter.delete('/sessions/:sessionId', asyncHandler(controller.deleteSession));

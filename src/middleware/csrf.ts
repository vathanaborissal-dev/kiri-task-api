import type { NextFunction, Request, Response } from 'express';
import { CSRF_COOKIE, CSRF_HEADER } from '../lib/cookies.js';
import { forbidden } from '../lib/errors.js';
import { safeEqual } from '../lib/crypto.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit cookie check. Cookies are SameSite=Lax, which already blocks
 * cross-site form posts; this adds a second, explicit barrier for anything
 * that mutates state. Bearer-token clients (the Telegram worker) are exempt.
 */
export const csrfProtection = (req: Request, _res: Response, next: NextFunction) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.headers.authorization?.startsWith('Bearer ')) return next();

  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.headers[CSRF_HEADER];

  if (!cookie || typeof header !== 'string' || !safeEqual(cookie, header)) {
    return next(forbidden('Invalid or missing CSRF token. Please reload the page and try again.'));
  }
  next();
};

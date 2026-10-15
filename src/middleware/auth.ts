import type { NextFunction, Request, Response } from 'express';
import { ACCESS_COOKIE } from '../lib/cookies.js';
import { unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { sessionIsLive } from '../modules/auth/auth.service.js';
import { AuthContext } from '../services/authContext.js';

const extractToken = (req: Request): string | null => {
  const cookieToken = req.cookies?.[ACCESS_COOKIE];
  if (typeof cookieToken === 'string' && cookieToken.length > 0) return cookieToken;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
};

export const requireAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const token = extractToken(req);
    if (!token) throw unauthorized();
    const payload = verifyAccessToken(token);
    // Both reads in one round trip: the account has to still be active, and the
    // session the token was minted for has to still exist.
    const [auth, live] = await Promise.all([
      AuthContext.forUserId(payload.sub),
      sessionIsLive(payload.fam),
    ]);
    if (!auth) throw unauthorized('Your account is no longer active');
    if (!live) throw unauthorized('Your session has expired');
    req.auth = auth;
    next();
  } catch (error) {
    next(error);
  }
};

/** Populates req.auth when a valid session exists, but never rejects. */
export const optionalAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const token = extractToken(req);
    if (token) {
      const payload = verifyAccessToken(token);
      const [auth, live] = await Promise.all([
        AuthContext.forUserId(payload.sub),
        sessionIsLive(payload.fam),
      ]);
      req.auth = live ? (auth ?? undefined) : undefined;
    }
  } catch {
    /* anonymous */
  }
  next();
};

export const getAuth = (req: Request): AuthContext => {
  if (!req.auth) throw unauthorized();
  return req.auth;
};

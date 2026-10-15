import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthorized } from './errors.js';

export type AccessTokenPayload = {
  sub: string;
  email: string;
  /**
   * Refresh-token family this access token belongs to.
   *
   * Access tokens are stateless, so revoking a session used to leave its access
   * token working until it expired. Carrying the family means `requireAuth` can
   * check the session is still alive, and a password reset or "sign out
   * everywhere" takes effect on the next request rather than up to 15 minutes
   * later.
   */
  fam: string;
  typ: 'access';
};

export const signAccessToken = (payload: Omit<AccessTokenPayload, 'typ'>): string =>
  jwt.sign({ ...payload, typ: 'access' }, env.APP_JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    issuer: 'kiri-task',
    audience: 'kiri-task-web',
  });

export const verifyAccessToken = (token: string): AccessTokenPayload => {
  try {
    const decoded = jwt.verify(token, env.APP_JWT_SECRET, {
      issuer: 'kiri-task',
      audience: 'kiri-task-web',
    }) as AccessTokenPayload;
    if (decoded.typ !== 'access') throw new Error('wrong token type');
    // Tokens minted before sessions were bound to a family have no `fam`, so
    // they cannot be checked against a live session. Reject them; the client
    // refreshes and gets a token that can be.
    if (typeof decoded.fam !== 'string' || decoded.fam.length === 0) {
      throw new Error('token predates session binding');
    }
    return decoded;
  } catch {
    throw unauthorized('Your session has expired');
  }
};

/** Signs short-lived, single-purpose tokens (e.g. Telegram deep links). */
export const signScopedToken = (payload: Record<string, unknown>, expiresIn: string): string =>
  jwt.sign(payload, env.APP_JWT_SECRET, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });

export const verifyScopedToken = <T>(token: string): T => {
  try {
    return jwt.verify(token, env.APP_JWT_SECRET) as T;
  } catch {
    throw unauthorized('This link is invalid or has expired');
  }
};
